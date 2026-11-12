-- IOYA: "Maintain Contacts", "Maintain Groups" and "Maintain Payment Methods" for admins
-- (/admin#contacts, #groups, #methods).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after admin-login.sql (is_admin()) and contact-payment-methods.sql (Cash App, Apple Cash).
--
-- Every function here starts by checking is_admin(), so only admins can use them, even though the
-- browser can call them. Rules kept from the app:
--   * Each user's own "You" contact (same first name, last name and phone as their users row) is
--     edited only through Maintain Users, so it stays matched to the user. It can't be deleted.
--   * A contact who is on a past split can't be deleted (History would lose them).
--   * Deleting a group keeps its contacts.
--   * The six built-in payment methods (Venmo, PayPal, Zelle, Cash, Cash App, Apple Cash) can't be
--     renamed or deleted: the app recognizes them by name. Added methods can be renamed, and deleted
--     once no contact or payment uses them.
-- A contact's or group's owner is chosen when it is added and can't be changed afterwards.

-- ---------- Contacts ----------
CREATE OR REPLACE FUNCTION admin_list_contacts()
RETURNS TABLE (contact_id integer, user_id integer, owner_first text, owner_last text, owner_kind text,
               first_name text, last_name text, phone text, is_self boolean, methods jsonb,
               groups integer, splits integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain contacts.';
  END IF;
  RETURN QUERY
  SELECT c.contact_id, c.user_id, u.user_first_name::text, u.user_last_name::text,
         CASE WHEN u.auth_user_id IS NULL THEN 'none'
              WHEN coalesce(a.is_anonymous, false) THEN 'guest'
              WHEN u.is_admin THEN 'admin' ELSE 'profile' END,
         c.cont_first_name::text, c.cont_last_name::text, c.phone::text,
         (c.cont_first_name = u.user_first_name AND c.cont_last_name = u.user_last_name AND c.phone IS NOT DISTINCT FROM u.phone),
         coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.pay_method_id, 'name', pm.pay_method_name,
                     'username', m.pay_method_username, 'preferred', m.is_preferred) ORDER BY m.pay_method_id)
                     FROM contacts_payment_method m JOIN payment_methods pm ON pm.pay_method_id = m.pay_method_id
                    WHERE m.contact_id = c.contact_id), '[]'::jsonb),
         (SELECT count(*)::integer FROM group_members g WHERE g.contact_id = c.contact_id),
         (SELECT count(*)::integer FROM participants p WHERE p.contact_id = c.contact_id)
    FROM contacts c JOIN users u ON u.user_id = c.user_id LEFT JOIN auth.users a ON a.id = u.auth_user_id
   ORDER BY c.contact_id;
END $$;

-- Add (p_contact_id NULL, for owner p_user_id) or edit a contact. p_methods is a list like
-- [{"pay_method_id": 1, "username": "@sam", "preferred": true}]; blank usernames are left out, and it
-- replaces the contact's old list. Returns the contact_id.
CREATE OR REPLACE FUNCTION admin_save_contact(
  p_contact_id integer,
  p_user_id    integer,
  p_first_name text,
  p_last_name  text,
  p_phone      text,
  p_methods    jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_first   constant text := trim(coalesce(p_first_name, ''));
  v_last    constant text := trim(coalesce(p_last_name, ''));
  v_phone   constant text := nullif(trim(coalesce(p_phone, '')), '');
  v_methods jsonb;
  v_old     contacts%ROWTYPE;
  v_owner   users%ROWTYPE;
  v_id      integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain contacts.';
  END IF;
  IF v_first = '' THEN RAISE EXCEPTION 'Add a first name.'; END IF;
  IF length(v_first) > 50 OR length(v_last) > 50 THEN RAISE EXCEPTION 'Names can be at most 50 characters.'; END IF;
  IF v_phone IS NOT NULL AND (v_phone !~ '^[0-9()+. -]+$'
      OR length(regexp_replace(v_phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15) THEN
    RAISE EXCEPTION 'Enter a phone number with 7 to 15 digits, or leave it blank.';
  END IF;

  -- Payment usernames: drop blanks, then check what's left.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', (m->>'pay_method_id')::integer, 'username', trim(m->>'username'),
           'preferred', coalesce((m->>'preferred')::boolean, false))), '[]'::jsonb)
    INTO v_methods
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_methods) = 'array' THEN p_methods ELSE '[]'::jsonb END) m
   WHERE coalesce(trim(m->>'username'), '') <> '';
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_methods) m
              WHERE NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.pay_method_id = (m->>'id')::integer)) THEN
    RAISE EXCEPTION 'One of those payment methods no longer exists. Refresh the page and try again.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_methods) m WHERE length(m->>'username') > 100) THEN
    RAISE EXCEPTION 'Payment usernames can be at most 100 characters.';
  END IF;
  IF (SELECT count(DISTINCT m->>'id') FROM jsonb_array_elements(v_methods) m) < jsonb_array_length(v_methods) THEN
    RAISE EXCEPTION 'Each payment method can be listed only once.';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(v_methods) m WHERE (m->>'preferred')::boolean) > 1 THEN
    RAISE EXCEPTION 'Pick only one preferred payment method.';
  END IF;

  IF p_contact_id IS NULL THEN
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Pick who this contact belongs to.'; END IF;
    SELECT * INTO v_owner FROM users WHERE user_id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That owner no longer exists. Refresh the page and try again.'; END IF;
  ELSE
    SELECT * INTO v_old FROM contacts WHERE contact_id = p_contact_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That contact no longer exists. Refresh the page and try again.'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_old.user_id THEN
      RAISE EXCEPTION 'A contact''s owner can''t be changed. Add a new contact for the other user instead.';
    END IF;
    SELECT * INTO v_owner FROM users WHERE user_id = v_old.user_id;
    IF v_old.cont_first_name = v_owner.user_first_name AND v_old.cont_last_name = v_owner.user_last_name
       AND v_old.phone IS NOT DISTINCT FROM v_owner.phone THEN
      RAISE EXCEPTION 'This is the user''s own "You" contact. Change their name and phone in Maintain Users instead.';
    END IF;
  END IF;
  -- Matching the owner's own name and phone would make IOYA treat this contact as "You".
  IF v_first = v_owner.user_first_name AND v_last = v_owner.user_last_name AND v_phone IS NOT DISTINCT FROM v_owner.phone THEN
    RAISE EXCEPTION 'That''s the same name and phone as the owner''s own profile. Change the name or phone so IOYA can tell them apart.';
  END IF;

  IF p_contact_id IS NULL THEN
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id)
    VALUES (v_first, v_last, v_phone, v_owner.user_id) RETURNING contact_id INTO v_id;
  ELSE
    UPDATE contacts SET cont_first_name = v_first, cont_last_name = v_last, phone = v_phone
     WHERE contact_id = p_contact_id RETURNING contact_id INTO v_id;
    DELETE FROM contacts_payment_method WHERE contact_id = v_id;
  END IF;
  INSERT INTO contacts_payment_method (contact_id, pay_method_id, pay_method_username, is_preferred)
  SELECT v_id, (m->>'id')::integer, m->>'username', (m->>'preferred')::boolean FROM jsonb_array_elements(v_methods) m;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION admin_delete_contact(p_contact_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old   contacts%ROWTYPE;
  v_owner users%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain contacts.';
  END IF;
  SELECT * INTO v_old FROM contacts WHERE contact_id = p_contact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That contact no longer exists. Refresh the page and try again.'; END IF;
  SELECT * INTO v_owner FROM users WHERE user_id = v_old.user_id;
  IF v_old.cont_first_name = v_owner.user_first_name AND v_old.cont_last_name = v_owner.user_last_name
     AND v_old.phone IS NOT DISTINCT FROM v_owner.phone THEN
    RAISE EXCEPTION 'This is the user''s own "You" contact, so it can''t be deleted. Delete the user in Maintain Users instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM participants WHERE contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'This contact is on a past split, so they can''t be deleted.';
  END IF;
  DELETE FROM contacts WHERE contact_id = p_contact_id;  -- payment usernames and group memberships go with it
END $$;

-- ---------- Groups ----------
CREATE OR REPLACE FUNCTION admin_list_groups()
RETURNS TABLE (group_id integer, group_name text, user_id integer, owner_first text, owner_last text, owner_kind text, members jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain groups.';
  END IF;
  RETURN QUERY
  SELECT g.group_id, g.group_name::text, g.user_id, u.user_first_name::text, u.user_last_name::text,
         CASE WHEN u.auth_user_id IS NULL THEN 'none'
              WHEN coalesce(a.is_anonymous, false) THEN 'guest'
              WHEN u.is_admin THEN 'admin' ELSE 'profile' END,
         coalesce((SELECT jsonb_agg(jsonb_build_object('contact_id', c.contact_id, 'first_name', c.cont_first_name, 'last_name', c.cont_last_name)
                     ORDER BY lower(c.cont_first_name), lower(c.cont_last_name), c.contact_id)
                     FROM group_members gm JOIN contacts c ON c.contact_id = gm.contact_id
                    WHERE gm.group_id = g.group_id), '[]'::jsonb)
    FROM friend_groups g JOIN users u ON u.user_id = g.user_id LEFT JOIN auth.users a ON a.id = u.auth_user_id
   ORDER BY g.group_id;
END $$;

-- Add (p_group_id NULL, for owner p_user_id) or edit a group. p_contact_ids is the full member list
-- (it replaces the old one; it may be empty). Members must be the owner's contacts. Returns the group_id.
CREATE OR REPLACE FUNCTION admin_save_group(
  p_group_id    integer,
  p_user_id     integer,
  p_name        text,
  p_contact_ids integer[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name  constant text := trim(coalesce(p_name, ''));
  v_ids   constant integer[] := coalesce(p_contact_ids, '{}');
  v_owner integer;
  v_id    integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain groups.';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Add a group name.'; END IF;
  IF length(v_name) > 50 THEN RAISE EXCEPTION 'Group names can be at most 50 characters.'; END IF;

  IF p_group_id IS NULL THEN
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Pick who this group belongs to.'; END IF;
    SELECT u.user_id INTO v_owner FROM users u WHERE u.user_id = p_user_id;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'That owner no longer exists. Refresh the page and try again.'; END IF;
  ELSE
    SELECT g.user_id INTO v_owner FROM friend_groups g WHERE g.group_id = p_group_id FOR UPDATE;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'That group no longer exists. Refresh the page and try again.'; END IF;
    IF p_user_id IS NOT NULL AND p_user_id <> v_owner THEN
      RAISE EXCEPTION 'A group''s owner can''t be changed. Add a new group for the other user instead.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS id
              WHERE id IS NULL OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.contact_id = id AND c.user_id = v_owner)) THEN
    RAISE EXCEPTION 'Members must be the owner''s contacts. One of them isn''t (or no longer exists); refresh the page and try again.';
  END IF;

  IF p_group_id IS NULL THEN
    INSERT INTO friend_groups (group_name, user_id) VALUES (v_name, v_owner) RETURNING group_id INTO v_id;
  ELSE
    UPDATE friend_groups SET group_name = v_name WHERE group_id = p_group_id RETURNING group_id INTO v_id;
    DELETE FROM group_members WHERE group_id = v_id;
  END IF;
  INSERT INTO group_members (group_id, contact_id) SELECT DISTINCT v_id, id FROM unnest(v_ids) AS id;
  RETURN v_id;
END $$;

-- Delete a group. Its contacts are kept; groups aren't linked to past splits.
CREATE OR REPLACE FUNCTION admin_delete_group(p_group_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain groups.';
  END IF;
  DELETE FROM friend_groups WHERE group_id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That group no longer exists. Refresh the page and try again.'; END IF;
END $$;

-- ---------- Payment methods ----------
CREATE OR REPLACE FUNCTION admin_list_payment_methods()
RETURNS TABLE (pay_method_id integer, pay_method_name text, built_in boolean, contacts integer, payments integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain payment methods.';
  END IF;
  RETURN QUERY
  SELECT pm.pay_method_id, pm.pay_method_name::text,
         pm.pay_method_name IN ('Venmo', 'PayPal', 'Zelle', 'Cash', 'Cash App', 'Apple Cash'),
         (SELECT count(*)::integer FROM contacts_payment_method m WHERE m.pay_method_id = pm.pay_method_id),
         (SELECT count(*)::integer FROM participants p WHERE p.paid_method_id = pm.pay_method_id)
    FROM payment_methods pm
   ORDER BY pm.pay_method_id;
END $$;

-- Add (p_pay_method_id NULL) or rename an added payment method. Returns its id.
CREATE OR REPLACE FUNCTION admin_save_payment_method(p_pay_method_id integer, p_name text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name  constant text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old   text;
  v_id    integer;
  v_seq   constant text := pg_get_serial_sequence('public.payment_methods', 'pay_method_id');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain payment methods.';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Add a name for the payment method.'; END IF;
  IF length(v_name) > 30 THEN RAISE EXCEPTION 'Payment method names can be at most 30 characters.'; END IF;
  LOCK TABLE payment_methods IN SHARE ROW EXCLUSIVE MODE;

  IF p_pay_method_id IS NOT NULL THEN
    SELECT pay_method_name INTO v_old FROM payment_methods WHERE pay_method_id = p_pay_method_id;
    IF v_old IS NULL THEN RAISE EXCEPTION 'That payment method no longer exists. Refresh the page and try again.'; END IF;
    IF v_old IN ('Venmo', 'PayPal', 'Zelle', 'Cash', 'Cash App', 'Apple Cash') THEN
      RAISE EXCEPTION '% is built into IOYA, so it can''t be renamed.', v_old;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM payment_methods WHERE lower(pay_method_name) = lower(v_name) AND pay_method_id IS DISTINCT FROM p_pay_method_id) THEN
    RAISE EXCEPTION 'There''s already a payment method named %.', v_name;
  END IF;

  IF p_pay_method_id IS NOT NULL THEN
    UPDATE payment_methods SET pay_method_name = v_name WHERE pay_method_id = p_pay_method_id;
    RETURN p_pay_method_id;
  END IF;
  -- Pick the next id ourselves: older setup files inserted ids directly, so the counter may be behind.
  SELECT greatest(coalesce(max(pay_method_id), 0), 6) + 1 INTO v_id FROM payment_methods;
  INSERT INTO payment_methods (pay_method_id, pay_method_name) VALUES (v_id, v_name);
  IF v_seq IS NOT NULL THEN PERFORM setval(v_seq, v_id, true); END IF;
  RETURN v_id;
END $$;

-- Delete an added payment method that nothing uses.
CREATE OR REPLACE FUNCTION admin_delete_payment_method(p_pay_method_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name     text;
  v_contacts integer;
  v_payments integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain payment methods.';
  END IF;
  SELECT pay_method_name INTO v_name FROM payment_methods WHERE pay_method_id = p_pay_method_id FOR UPDATE;
  IF v_name IS NULL THEN RAISE EXCEPTION 'That payment method no longer exists. Refresh the page and try again.'; END IF;
  IF v_name IN ('Venmo', 'PayPal', 'Zelle', 'Cash', 'Cash App', 'Apple Cash') THEN
    RAISE EXCEPTION '% is built into IOYA, so it can''t be deleted.', v_name;
  END IF;
  SELECT count(*) INTO v_contacts FROM contacts_payment_method WHERE pay_method_id = p_pay_method_id;
  SELECT count(*) INTO v_payments FROM participants WHERE paid_method_id = p_pay_method_id;
  IF v_contacts > 0 THEN
    RAISE EXCEPTION '% contact% still % a % username. Remove it from them first (Maintain Contacts).',
      v_contacts, CASE WHEN v_contacts = 1 THEN '' ELSE 's' END, CASE WHEN v_contacts = 1 THEN 'has' ELSE 'have' END, v_name;
  END IF;
  IF v_payments > 0 THEN
    RAISE EXCEPTION '% was used to mark % payment% as paid, so it can''t be deleted.',
      v_name, v_payments, CASE WHEN v_payments = 1 THEN '' ELSE 's' END;
  END IF;
  DELETE FROM payment_methods WHERE pay_method_id = p_pay_method_id;
END $$;

REVOKE ALL ON FUNCTION admin_list_contacts(), admin_save_contact(integer, integer, text, text, text, jsonb), admin_delete_contact(integer),
  admin_list_groups(), admin_save_group(integer, integer, text, integer[]), admin_delete_group(integer),
  admin_list_payment_methods(), admin_save_payment_method(integer, text), admin_delete_payment_method(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_contacts(), admin_save_contact(integer, integer, text, text, text, jsonb), admin_delete_contact(integer),
  admin_list_groups(), admin_save_group(integer, integer, text, integer[]), admin_delete_group(integer),
  admin_list_payment_methods(), admin_save_payment_method(integer, text), admin_delete_payment_method(integer) TO authenticated;
