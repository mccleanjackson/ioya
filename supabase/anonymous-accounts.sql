-- IOYA: an account for every visitor (Supabase anonymous sign-in).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Also turn on Authentication → Sign In / Providers → "Allow anonymous sign-ins".
--
-- Each browser signs in silently and gets its own Supabase Auth user. This file links our users
-- table to Supabase Auth, creates a users row and "You" contact on first visit, and makes the
-- contact functions act for whoever is signed in instead of always user 1.
--
-- This does NOT make data private yet: signed-in users get the same access the anon key has
-- (read every table, mark as paid, contact functions). The demo data (user 1) is not changed.

-- Link each users row to its Supabase Auth user. Empty for the demo users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- The users row of whoever is calling. Callers who aren't signed in (an old copy of the app still
-- open somewhere) keep acting as the demo user, until the security rules are rewritten.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN auth.uid() IS NULL THEN 1
              ELSE (SELECT user_id FROM users WHERE auth_user_id = auth.uid()) END
$$;

-- Find or create the signed-in person's users row, plus their own contact row ("You").
-- New users start with a blank name; the contact gets the same blank name and phone so the
-- app's "same name and phone" match still finds it. Returns their user_id.
CREATE OR REPLACE FUNCTION ensure_my_user() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auth_id uuid := auth.uid();
  v_user_id integer;
BEGIN
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'You are not signed in. Refresh the page to try again.';
  END IF;
  SELECT user_id INTO v_user_id FROM users WHERE auth_user_id = v_auth_id;
  IF v_user_id IS NOT NULL THEN
    RETURN v_user_id;
  END IF;

  INSERT INTO users (user_first_name, user_last_name, phone, auth_user_id)
  VALUES ('', '', NULL, v_auth_id)
  ON CONFLICT (auth_user_id) DO NOTHING
  RETURNING user_id INTO v_user_id;
  IF v_user_id IS NULL THEN  -- another tab created it at the same moment
    SELECT user_id INTO v_user_id FROM users WHERE auth_user_id = v_auth_id;
  ELSE
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id) VALUES ('', '', NULL, v_user_id);
  END IF;
  RETURN v_user_id;
END $$;

-- Same as before, but contacts belong to the signed-in user instead of always user 1.
CREATE OR REPLACE FUNCTION save_contact(
  p_contact_id  integer,
  p_first_name  text,
  p_last_name   text,
  p_phone       text,
  p_methods     jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contact_id integer;
  v_user_id    constant integer := app_user_id();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF coalesce(trim(p_first_name), '') = '' THEN
    RAISE EXCEPTION 'Add a first name.';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_methods, '[]')) m
       WHERE coalesce((m->>'preferred')::boolean, false) AND coalesce(trim(m->>'username'), '') <> '') > 1 THEN
    RAISE EXCEPTION 'Pick only one preferred payment method.';
  END IF;

  IF p_contact_id IS NULL THEN
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id)
    VALUES (trim(p_first_name), coalesce(trim(p_last_name), ''), nullif(trim(p_phone), ''), v_user_id)
    RETURNING contact_id INTO v_contact_id;
  ELSE
    IF EXISTS (SELECT 1 FROM contacts c JOIN users u ON u.user_id = c.user_id
                WHERE c.contact_id = p_contact_id AND u.user_id = v_user_id AND c.cont_first_name = u.user_first_name
                  AND c.cont_last_name = u.user_last_name AND c.phone IS NOT DISTINCT FROM u.phone) THEN
      RAISE EXCEPTION 'You can''t edit your own contact here.';
    END IF;
    UPDATE contacts
       SET cont_first_name = trim(p_first_name),
           cont_last_name  = coalesce(trim(p_last_name), ''),
           phone           = nullif(trim(p_phone), '')
     WHERE contact_id = p_contact_id AND user_id = v_user_id
    RETURNING contact_id INTO v_contact_id;
    IF v_contact_id IS NULL THEN
      RAISE EXCEPTION 'That contact no longer exists.';
    END IF;
    DELETE FROM contacts_payment_method WHERE contact_id = v_contact_id;
  END IF;

  INSERT INTO contacts_payment_method (contact_id, pay_method_id, pay_method_username, is_preferred)
  SELECT v_contact_id, (m->>'pay_method_id')::integer, trim(m->>'username'), coalesce((m->>'preferred')::boolean, false)
    FROM jsonb_array_elements(coalesce(p_methods, '[]')) m
   WHERE coalesce(trim(m->>'username'), '') <> '';

  RETURN v_contact_id;
END $$;

-- Same as before, but only for the signed-in user's own contacts.
CREATE OR REPLACE FUNCTION delete_contact(p_contact_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id constant integer := app_user_id();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE contact_id = p_contact_id AND user_id = v_user_id) THEN
    RAISE EXCEPTION 'That contact no longer exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM participants WHERE contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'This contact is part of a past split, so they can''t be deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM contacts c JOIN users u ON u.user_id = c.user_id
              WHERE c.contact_id = p_contact_id AND c.cont_first_name = u.user_first_name
                AND c.cont_last_name = u.user_last_name AND c.phone IS NOT DISTINCT FROM u.phone) THEN
    RAISE EXCEPTION 'You can''t delete your own contact.';
  END IF;
  DELETE FROM contacts WHERE contact_id = p_contact_id AND user_id = v_user_id;
END $$;

-- Signed-in users (anonymous ones included) use the "authenticated" role, not "anon".
-- Give them the same access anon has: read every table and mark as paid.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','contacts','friend_groups','group_members','payment_methods',
    'contacts_payment_method','events','receipts','line_items','participants','item_assignments']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Signed-in read" ON %I', t);
    EXECUTE format('CREATE POLICY "Signed-in read" ON %I FOR SELECT TO authenticated USING (true)', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS "Signed-in can mark paid" ON participants;
CREATE POLICY "Signed-in can mark paid" ON participants FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT UPDATE (paid_method_id) ON participants TO anon, authenticated;

REVOKE ALL ON FUNCTION app_user_id(), ensure_my_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ensure_my_user() TO authenticated;
REVOKE ALL ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) TO anon, authenticated;
