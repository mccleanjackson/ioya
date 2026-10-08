-- Split Scan: let the app add, edit and delete contacts.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- (schema.sql already includes this, so a brand-new project doesn't need it separately.)
--
-- The anon key still cannot write to the contact tables directly. Instead it may call these
-- two functions, which check the input and make all their changes in one transaction.

-- Create a contact (p_contact_id = null) or replace an existing one, along with its payment methods.
-- p_methods is a JSON array like: [{"pay_method_id": 1, "username": "@tanner", "preferred": true}]
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
  v_user_id    constant integer := 1;  -- No login yet: every contact belongs to the demo user.
BEGIN
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

-- Delete a contact, unless they are on a past split (deleting them would erase their
-- items from that receipt) or they are the user's own "You" row.
CREATE OR REPLACE FUNCTION delete_contact(p_contact_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM participants WHERE contact_id = p_contact_id) THEN
    RAISE EXCEPTION 'This contact is part of a past split, so they can''t be deleted.';
  END IF;
  IF EXISTS (SELECT 1 FROM contacts c JOIN users u ON u.user_id = c.user_id
              WHERE c.contact_id = p_contact_id AND c.cont_first_name = u.user_first_name
                AND c.cont_last_name = u.user_last_name AND c.phone IS NOT DISTINCT FROM u.phone) THEN
    RAISE EXCEPTION 'You can''t delete your own contact.';
  END IF;
  DELETE FROM contacts WHERE contact_id = p_contact_id AND user_id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That contact no longer exists.';
  END IF;
END $$;

REVOKE ALL ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) TO anon;
