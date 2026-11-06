-- IOYA: let people edit their own profile (name and phone).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run private-data.sql first (it already has been on our shared project).
--
-- Each user has a users row and a matching "You" contact (same first name, last name and phone).
-- The app finds "You" by that match, so the two must always change together. This function does
-- both in one transaction. Email addresses are not stored here: they live in Supabase Auth.

CREATE OR REPLACE FUNCTION save_my_profile(
  p_first_name  text,
  p_last_name   text,
  p_phone       text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  constant integer := app_user_id();
  v_first    constant text := trim(coalesce(p_first_name, ''));
  v_last     constant text := trim(coalesce(p_last_name, ''));
  v_phone    constant text := nullif(trim(coalesce(p_phone, '')), '');
  v_old      users%ROWTYPE;
  v_self_id  integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF v_first = '' THEN
    RAISE EXCEPTION 'Add your first name.';
  END IF;
  IF length(v_first) > 50 OR length(v_last) > 50 THEN
    RAISE EXCEPTION 'Names can be at most 50 characters.';
  END IF;
  IF v_phone IS NOT NULL AND (v_phone !~ '^[0-9()+. -]+$'
      OR length(regexp_replace(v_phone, '[^0-9]', '', 'g')) NOT BETWEEN 7 AND 15) THEN
    RAISE EXCEPTION 'Enter a phone number with 7 to 15 digits, or leave it blank.';
  END IF;

  -- Lock the users row so two tabs saving at once can't break the "You" match.
  SELECT * INTO v_old FROM users WHERE user_id = v_user_id FOR UPDATE;

  -- The current "You" contact: same name and phone as the users row (before this change).
  SELECT contact_id INTO v_self_id FROM contacts
   WHERE user_id = v_user_id AND cont_first_name = v_old.user_first_name
     AND cont_last_name = v_old.user_last_name AND phone IS NOT DISTINCT FROM v_old.phone
   ORDER BY contact_id LIMIT 1;

  -- If another contact had exactly the new name and phone, the app couldn't tell which one is "You".
  IF EXISTS (SELECT 1 FROM contacts
              WHERE user_id = v_user_id AND contact_id IS DISTINCT FROM v_self_id
                AND cont_first_name = v_first AND cont_last_name = v_last AND phone IS NOT DISTINCT FROM v_phone) THEN
    RAISE EXCEPTION 'One of your contacts already has this exact name and phone. Change one of them so IOYA can tell which one is you.';
  END IF;

  UPDATE users SET user_first_name = v_first, user_last_name = v_last, phone = v_phone
   WHERE user_id = v_user_id;
  IF v_self_id IS NULL THEN
    -- The "You" contact went missing (for example, edited in the dashboard); make a new one.
    INSERT INTO contacts (cont_first_name, cont_last_name, phone, user_id) VALUES (v_first, v_last, v_phone, v_user_id);
  ELSE
    UPDATE contacts SET cont_first_name = v_first, cont_last_name = v_last, phone = v_phone
     WHERE contact_id = v_self_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION save_my_profile(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_my_profile(text, text, text) TO authenticated;
