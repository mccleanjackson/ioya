-- IOYA: "Maintain Users" for admins (/admin#users).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after admin-login.sql (users.user_email, users.is_admin, is_admin()) and avatars.sql (users.avatar_path).
--
-- Every function here starts by checking is_admin(), so only admins can use them, even though the
-- browser can call them. Admins can:
--   admin_list_users()   see every user, with their login type and how much data they have
--   admin_save_user()    add a user (no login yet) or edit one; keeps their "You" contact in sync
--   admin_delete_user()  delete a user and everything they own (contacts, groups, splits)
-- Safety rules: you can't delete yourself or remove your own admin access, guests can't be admins,
-- and the email of someone who already logs in can't be changed here (only they can change their
-- login email; changing it from here would need Supabase's secret key, which IOYA never uses).
--
-- This file also replaces ensure_my_user() once more (after admin-login.sql): when someone logs in for
-- the first time with an email that an admin already added, they are linked to that user instead of
-- getting a new, empty one. If you re-run admin-login.sql or anonymous-accounts.sql, run this after.

-- 1. List every user.
CREATE OR REPLACE FUNCTION admin_list_users()
RETURNS TABLE (user_id integer, first_name text, last_name text, email text, phone text, is_admin boolean,
               kind text, contacts integer, groups integer, splits integer, avatar_path text,
               joined_at timestamptz, last_login_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain users.';
  END IF;
  RETURN QUERY
  SELECT u.user_id, u.user_first_name::text, u.user_last_name::text, u.user_email, u.phone::text, u.is_admin,
         CASE WHEN u.auth_user_id IS NULL THEN 'none'
              WHEN coalesce(a.is_anonymous, false) THEN 'guest'
              WHEN u.is_admin THEN 'admin' ELSE 'profile' END,
         (SELECT count(*)::integer FROM contacts c WHERE c.user_id = u.user_id),
         (SELECT count(*)::integer FROM friend_groups g WHERE g.user_id = u.user_id),
         (SELECT count(DISTINCT r.event_id)::integer FROM receipts r WHERE r.payer_user_id = u.user_id),
         u.avatar_path, a.created_at, a.last_sign_in_at
    FROM users u LEFT JOIN auth.users a ON a.id = u.auth_user_id
   ORDER BY u.user_id;
END $$;

-- 2. Add (p_user_id NULL) or edit a user. Returns the user_id.
CREATE OR REPLACE FUNCTION admin_save_user(
  p_user_id    integer,
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_phone      text,
  p_is_admin   boolean
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_first   constant text := trim(coalesce(p_first_name, ''));
  v_last    constant text := trim(coalesce(p_last_name, ''));
  v_email   constant text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone   constant text := nullif(trim(coalesce(p_phone, '')), '');
  v_admin   constant boolean := coalesce(p_is_admin, false);
  v_old     users%ROWTYPE;
  v_guest   boolean := false;
  v_self_id integer;
  v_id      integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain users.';
  END IF;
  -- Same rules as the Profile screen (save_my_profile), plus the email.
  IF v_first = '' THEN RAISE EXCEPTION 'Add a first name.'; END IF;
  IF length(v_first) > 50 OR length(v_last) > 50 THEN RAISE EXCEPTION 'Names can be at most 50 characters.'; END IF;
  IF v_phone IS NOT NULL AND (v_phone !~ '^[0-9()+. -]+$'
      OR length(regexp_replace(v_phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15) THEN
    RAISE EXCEPTION 'Enter a phone number with 7 to 15 digits, or leave it blank.';
  END IF;
  IF v_email IS NOT NULL AND (length(v_email) > 254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN
    RAISE EXCEPTION 'Enter a full email address, like name@example.com.';
  END IF;

  IF p_user_id IS NOT NULL THEN
    SELECT * INTO v_old FROM users WHERE user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That user no longer exists. Refresh the page and try again.'; END IF;
    SELECT coalesce(a.is_anonymous, false) INTO v_guest FROM auth.users a WHERE a.id = v_old.auth_user_id;
    IF v_old.auth_user_id IS NOT NULL AND v_email IS DISTINCT FROM lower(v_old.user_email) THEN
      RAISE EXCEPTION '%', CASE WHEN v_guest THEN 'Guests don''t have an email. They add one when they create a profile.'
        ELSE 'This user logs in with ' || coalesce(v_old.user_email, 'their own email') || '. Only they can change their login email.' END;
    END IF;
    IF p_user_id = app_user_id() AND NOT v_admin THEN
      RAISE EXCEPTION 'You can''t remove your own admin access. Ask another admin to do it.';
    END IF;
  END IF;
  -- Users added here may be admins (it takes effect when they log in), but guest accounts never.
  IF v_admin AND v_guest THEN
    RAISE EXCEPTION 'Guests can''t be admins. They need to create a profile first.';
  END IF;
  IF v_email IS NOT NULL AND EXISTS (SELECT 1 FROM users o WHERE lower(o.user_email) = v_email AND o.user_id IS DISTINCT FROM p_user_id) THEN
    RAISE EXCEPTION 'Another user already has this email.';
  END IF;

  IF p_user_id IS NULL THEN
    INSERT INTO users (user_first_name, user_last_name, phone, user_email, is_admin)
    VALUES (v_first, v_last, v_phone, v_email, v_admin) RETURNING user_id INTO v_id;
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id) VALUES (v_first, v_last, v_phone, v_id);
    RETURN v_id;
  END IF;

  -- Keep the "You" contact matching the users row (the app finds "You" by name + phone).
  SELECT contact_id INTO v_self_id FROM contacts
   WHERE user_id = p_user_id AND cont_first_name = v_old.user_first_name
     AND cont_last_name = v_old.user_last_name AND phone IS NOT DISTINCT FROM v_old.phone
   ORDER BY contact_id LIMIT 1;
  IF EXISTS (SELECT 1 FROM contacts
              WHERE user_id = p_user_id AND contact_id IS DISTINCT FROM v_self_id
                AND cont_first_name = v_first AND cont_last_name = v_last AND phone IS NOT DISTINCT FROM v_phone) THEN
    RAISE EXCEPTION 'One of this user''s contacts already has this exact name and phone. Change one of them so IOYA can tell which one is them.';
  END IF;
  UPDATE users SET user_first_name = v_first, user_last_name = v_last, phone = v_phone, user_email = v_email, is_admin = v_admin
   WHERE user_id = p_user_id;
  IF v_self_id IS NULL THEN
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id) VALUES (v_first, v_last, v_phone, p_user_id);
  ELSE
    UPDATE contacts SET cont_first_name = v_first, cont_last_name = v_last, phone = v_phone WHERE contact_id = v_self_id;
  END IF;
  RETURN p_user_id;
END $$;

-- 3. Delete a user and everything they own. Their splits go first (receipts point at their payer
--    without ON DELETE CASCADE); contacts, groups and payment accounts then go with the users row.
--    Their Supabase login (if any) stays: remove it in Authentication → Users if needed. If they log
--    in again, they start over with an empty account.
CREATE OR REPLACE FUNCTION admin_delete_user(p_user_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain users.';
  END IF;
  IF p_user_id = app_user_id() THEN
    RAISE EXCEPTION 'You can''t delete your own account here.';
  END IF;
  PERFORM 1 FROM users WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That user no longer exists. Refresh the page and try again.'; END IF;
  -- Splits whose receipts are all this user's: delete the whole event (receipts, items, who owes what).
  DELETE FROM events e
   WHERE EXISTS (SELECT 1 FROM receipts r WHERE r.event_id = e.event_id AND r.payer_user_id = p_user_id)
     AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.event_id = e.event_id AND r.payer_user_id <> p_user_id);
  -- Any of their receipts left in someone else's event.
  DELETE FROM receipts WHERE payer_user_id = p_user_id;
  DELETE FROM users WHERE user_id = p_user_id;
END $$;

-- 4. ensure_my_user(): as in admin-login.sql, plus linking a first login to an admin-added user.
CREATE OR REPLACE FUNCTION ensure_my_user() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auth_id uuid := auth.uid();
  v_email   text;
  v_guest   boolean;
  v_user_id integer;
BEGIN
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'You are not signed in. Refresh the page to try again.';
  END IF;
  SELECT nullif(email, ''), coalesce(is_anonymous, false) INTO v_email, v_guest FROM auth.users WHERE id = v_auth_id;
  SELECT user_id INTO v_user_id FROM users WHERE auth_user_id = v_auth_id;

  IF v_user_id IS NULL AND v_email IS NOT NULL AND NOT v_guest THEN
    -- First login for someone an admin added with this email: take over that user.
    UPDATE users SET auth_user_id = v_auth_id
     WHERE user_id = (SELECT u.user_id FROM users u WHERE u.auth_user_id IS NULL AND lower(u.user_email) = lower(v_email)
                       ORDER BY u.user_id LIMIT 1)
    RETURNING user_id INTO v_user_id;
  END IF;

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

REVOKE ALL ON FUNCTION admin_list_users(), admin_save_user(integer, text, text, text, text, boolean),
  admin_delete_user(integer), ensure_my_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_users(), admin_save_user(integer, text, text, text, text, boolean),
  admin_delete_user(integer), ensure_my_user() TO authenticated;
