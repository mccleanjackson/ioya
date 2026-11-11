-- IOYA: email + password login and admin accounts (landing page and "Maintain" pages).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after anonymous-accounts.sql and private-data.sql (both already run on our shared project).
--
-- * users.user_email: the profile's email (the course spec calls it user_email). The app fills it in
--   from Supabase Auth through ensure_my_user(). Passwords are NOT stored in our tables: Supabase
--   Auth keeps them hashed in auth.users.
-- * users.is_admin: admins see the "Maintain" buttons on the landing page. Only an admin (or someone
--   in this SQL Editor) can change it. To make an account an admin, log in with it once, then run:
--     UPDATE users SET is_admin = true WHERE lower(user_email) = lower('their@email.com');
-- * is_admin(): true only for a signed-in, non-guest account whose users row has is_admin = true.
--   Every admin database function checks it.
-- This file also replaces ensure_my_user() from anonymous-accounts.sql (same behavior, plus it keeps
-- user_email up to date). If you ever re-run anonymous-accounts.sql, run this file again after it.

-- 1. New columns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS users_user_email_key ON users (lower(user_email));

-- 2. Fill in the emails of profiles that already exist.
UPDATE users u SET user_email = a.email
  FROM auth.users a
 WHERE a.id = u.auth_user_id AND nullif(a.email, '') IS NOT NULL AND u.user_email IS DISTINCT FROM a.email
   AND NOT EXISTS (SELECT 1 FROM users o WHERE lower(o.user_email) = lower(a.email) AND o.user_id <> u.user_id);

-- 3. Is the caller an admin?
CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT u.is_admin FROM users u WHERE u.auth_user_id = auth.uid()), false)
     AND coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) IS FALSE;
$$;
REVOKE ALL ON FUNCTION is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

-- 4. ensure_my_user(): find or create the caller's users row and "You" contact, and keep user_email
--    matching the email they log in with.
CREATE OR REPLACE FUNCTION ensure_my_user() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auth_id uuid := auth.uid();
  v_email   text;
  v_user_id integer;
BEGIN
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'You are not signed in. Refresh the page to try again.';
  END IF;
  SELECT nullif(email, '') INTO v_email FROM auth.users WHERE id = v_auth_id;
  SELECT user_id INTO v_user_id FROM users WHERE auth_user_id = v_auth_id;

  IF v_user_id IS NULL THEN
    INSERT INTO users (user_first_name, user_last_name, phone, auth_user_id)
    VALUES ('', '', NULL, v_auth_id)
    ON CONFLICT (auth_user_id) DO NOTHING
    RETURNING user_id INTO v_user_id;
    IF v_user_id IS NULL THEN  -- another tab created it at the same moment
      SELECT user_id INTO v_user_id FROM users WHERE auth_user_id = v_auth_id;
    ELSE
      INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id) VALUES ('', '', NULL, v_user_id);
    END IF;
  END IF;

  IF v_email IS NOT NULL THEN
    BEGIN
      UPDATE users SET user_email = v_email WHERE user_id = v_user_id AND user_email IS DISTINCT FROM v_email;
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- another users row already has this email; leave this one as it is
    END;
  END IF;
  RETURN v_user_id;
END $$;
REVOKE ALL ON FUNCTION ensure_my_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ensure_my_user() TO authenticated;
