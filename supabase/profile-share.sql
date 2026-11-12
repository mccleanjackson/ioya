-- IOYA: share your profile with a QR code (Profile → Share my profile).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after private-data.sql (app_user_id()), avatars.sql (users.avatar_path) and
-- profile-payment-accounts.sql + payment-preference.sql (your payment apps).
--
-- Each saved profile can get a random 10-character code. The page /u/<code> shows that person's
-- name, photo and payment apps to anyone with the link, so a friend can pay them without an account.
-- * The code is random (not the user number), so nobody can find other profiles by guessing.
-- * Guests can't get a code; only profiles saved with an email can be shared.
-- * new_my_profile_code() replaces the code; the old link and QR code stop working right away.
-- * read_profile(code) is the only function strangers can call. It returns the first name, last name,
--   photo path and payment apps, and nothing else (no phone, email, contacts or splits).

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_code text;
CREATE UNIQUE INDEX IF NOT EXISTS users_profile_code ON users (profile_code);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_code_check;
ALTER TABLE users ADD CONSTRAINT users_profile_code_check CHECK (profile_code ~ '^[a-z2-9]{10}$');

-- A new random code: 10 characters from 32 letters and digits (no 0, 1, l or o, which look alike).
-- The randomness comes from gen_random_uuid(), which uses a secure random source.
CREATE OR REPLACE FUNCTION make_profile_code()
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE
  v_letters constant text := '23456789abcdefghijkmnpqrstuvwxyz';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_code text := '';
  v_i integer;
BEGIN
  -- Bytes 6 and 8 of a UUID hold its version, so skip them.
  FOREACH v_i IN ARRAY ARRAY[0, 1, 2, 3, 4, 5, 9, 10, 11, 12] LOOP
    v_code := v_code || substr(v_letters, 1 + get_byte(v_bytes, v_i) % 32, 1);
  END LOOP;
  RETURN v_code;
END $$;
REVOKE ALL ON FUNCTION make_profile_code() FROM PUBLIC, anon, authenticated;

-- Your code, made the first time you ask (or a fresh one when p_new is true).
CREATE OR REPLACE FUNCTION set_my_profile_code(p_new boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user constant integer := app_user_id();
  v_code text;
  v_try integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF (SELECT (auth.jwt() ->> 'is_anonymous')::boolean) IS NOT FALSE THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Create a profile to share it.';
  END IF;
  IF NOT p_new THEN
    SELECT u.profile_code INTO v_code FROM users u WHERE u.user_id = v_user;
    IF v_code IS NOT NULL THEN RETURN v_code; END IF;
  END IF;
  LOOP
    v_try := v_try + 1;
    BEGIN
      UPDATE users SET profile_code = make_profile_code() WHERE user_id = v_user RETURNING profile_code INTO v_code;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- Another profile already has that code (very unlikely): pick again.
      IF v_try >= 5 THEN RAISE; END IF;
    END;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION get_my_profile_code() RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT set_my_profile_code(false) $$;
CREATE OR REPLACE FUNCTION new_my_profile_code() RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT set_my_profile_code(true) $$;

REVOKE ALL ON FUNCTION set_my_profile_code(boolean), get_my_profile_code(), new_my_profile_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_my_profile_code(), new_my_profile_code() TO authenticated;

-- The public profile behind /u/<code>. Returns null when no profile has that code.
-- {"first": "Jackson", "last": "McClean", "avatar_path": "<auth id>/<name>.jpg" or null,
--  "accounts": {"venmo": "jackson-m", …}, "preferred": "venmo" or null}
CREATE OR REPLACE FUNCTION read_profile(p_code text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
           'first', u.user_first_name,
           'last', coalesce(u.user_last_name, ''),
           'avatar_path', u.avatar_path,
           'accounts', coalesce(p.accounts, '{}'::jsonb),
           'preferred', CASE WHEN p.accounts ? p.preferred THEN p.preferred END)
    FROM users u
    LEFT JOIN profile_payment_accounts p ON p.user_id = u.user_id
   WHERE p_code ~ '^[a-z2-9]{10}$' AND u.profile_code = p_code;
$$;
REVOKE ALL ON FUNCTION read_profile(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION read_profile(text) TO anon, authenticated;
