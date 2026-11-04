-- IOYA: make each account's data private (Row Level Security rewrite).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run anonymous-accounts.sql first (it already has been on our shared project).
--
-- Before: anyone with the anon key could read every table and mark any split as paid.
-- After:  a signed-in person can read only their own rows, and can mark paid only on their own splits.
--         Signed-out callers (just the anon key, no session) can read and change nothing.
-- Also: groups get an owner (friend_groups.user_id), and two new functions, save_group and
-- delete_group, let the app create, edit and delete groups.
--
-- "Own" means:
--   users                       your own row (auth_user_id = you)
--   contacts                    contacts.user_id is you
--   contacts_payment_method     the contact is yours
--   friend_groups               friend_groups.user_id is you (new column, added below)
--   group_members               the group is yours and the member is one of your contacts
--   payment_methods             everyone signed in (Venmo, PayPal, Zelle, Cash lookup list)
--   receipts                    you are the payer
--   events                      one of the event's receipts is yours
--   line_items                  the receipt is yours
--   participants                the event is yours (this is also the rule for "Mark as paid")
--   item_assignments            the line item's receipt is yours
--
-- The demo data (user 1, "Demo Payer") is not changed or deleted. No account signs in as user 1,
-- so after this it is visible only in the Supabase dashboard.

-- 1) Signed-out callers no longer act as the demo user. With no session this returns NULL,
--    so save_contact and delete_contact refuse them.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT user_id FROM users WHERE auth_user_id = auth.uid()
$$;

-- 1b) Give every group an owner, so groups can be created and edited in the app later.
--     Existing groups go to the owner of their members (all of ours are the demo user's);
--     a group with no members goes to the demo user.
ALTER TABLE friend_groups ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(user_id) ON DELETE CASCADE;
UPDATE friend_groups g
   SET user_id = coalesce((SELECT c.user_id FROM group_members gm JOIN contacts c ON c.contact_id = gm.contact_id
                            WHERE gm.group_id = g.group_id ORDER BY c.contact_id LIMIT 1), 1)
 WHERE user_id IS NULL;
ALTER TABLE friend_groups ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS friend_groups_user_id ON friend_groups (user_id);

-- 2) Small "is this mine?" checks used by the rules below. They run with the owner's rights so one
--    table's rule can look at another table without getting blocked by that table's own rule.
CREATE OR REPLACE FUNCTION owns_contact(p_contact_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM contacts WHERE contact_id = p_contact_id AND user_id = app_user_id())
$$;

CREATE OR REPLACE FUNCTION owns_group(p_group_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM friend_groups WHERE group_id = p_group_id AND user_id = app_user_id())
$$;

CREATE OR REPLACE FUNCTION owns_event(p_event_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM receipts WHERE event_id = p_event_id AND payer_user_id = app_user_id())
$$;

CREATE OR REPLACE FUNCTION owns_receipt(p_receipt_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM receipts WHERE receipt_id = p_receipt_id AND payer_user_id = app_user_id())
$$;

CREATE OR REPLACE FUNCTION owns_item(p_item_id integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM line_items li JOIN receipts r ON r.receipt_id = li.receipt_id
                  WHERE li.item_id = p_item_id AND r.payer_user_id = app_user_id())
$$;

-- 3) Remove every old rule (anon read, signed-in read, mark paid for anyone).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','contacts','friend_groups','group_members','payment_methods',
    'contacts_payment_method','events','receipts','line_items','participants','item_assignments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Public read" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Signed-in read" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "Read own rows" ON %I', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS "Public can mark paid" ON participants;
DROP POLICY IF EXISTS "Signed-in can mark paid" ON participants;
DROP POLICY IF EXISTS "Mark own splits paid" ON participants;

-- 4) New read rules: signed-in people only, own rows only.
CREATE POLICY "Read own rows" ON users                   FOR SELECT TO authenticated USING (auth_user_id = auth.uid());
CREATE POLICY "Read own rows" ON contacts                FOR SELECT TO authenticated USING (user_id = (SELECT app_user_id()));
CREATE POLICY "Read own rows" ON contacts_payment_method FOR SELECT TO authenticated USING (owns_contact(contact_id));
CREATE POLICY "Read own rows" ON friend_groups           FOR SELECT TO authenticated USING (user_id = (SELECT app_user_id()));
CREATE POLICY "Read own rows" ON group_members           FOR SELECT TO authenticated USING (owns_group(group_id) AND owns_contact(contact_id));
CREATE POLICY "Read own rows" ON payment_methods         FOR SELECT TO authenticated USING (true);
CREATE POLICY "Read own rows" ON receipts                FOR SELECT TO authenticated USING (payer_user_id = (SELECT app_user_id()));
CREATE POLICY "Read own rows" ON events                  FOR SELECT TO authenticated USING (owns_event(event_id));
CREATE POLICY "Read own rows" ON line_items              FOR SELECT TO authenticated USING (owns_receipt(receipt_id));
CREATE POLICY "Read own rows" ON participants            FOR SELECT TO authenticated USING (owns_event(event_id));
CREATE POLICY "Read own rows" ON item_assignments        FOR SELECT TO authenticated USING (owns_item(item_id));

-- 5) "Mark as paid": only on your own splits, and still only the paid_method_id column.
CREATE POLICY "Mark own splits paid" ON participants FOR UPDATE TO authenticated
  USING (owns_event(event_id)) WITH CHECK (owns_event(event_id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT UPDATE (paid_method_id) ON participants TO authenticated;

-- 6) Group editing from the app. Same pattern as save_contact: checked, all in one transaction,
--    and only for the signed-in person's own groups and contacts.
-- Create a group (p_group_id = null) or replace an existing one's name and members.
-- p_contact_ids is the full member list, for example ARRAY[2, 7, 8]. It may be empty.
-- Returns the group_id.
CREATE OR REPLACE FUNCTION save_group(
  p_group_id     integer,
  p_name         text,
  p_contact_ids  integer[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_group_id integer;
  v_user_id  constant integer := app_user_id();
  v_ids      constant integer[] := coalesce(p_contact_ids, '{}');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF coalesce(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Add a group name.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS id
              WHERE id IS NULL OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.contact_id = id AND c.user_id = v_user_id)) THEN
    RAISE EXCEPTION 'One of those contacts no longer exists. Refresh the page and try again.';
  END IF;

  IF p_group_id IS NULL THEN
    INSERT INTO friend_groups (group_name, user_id) VALUES (trim(p_name), v_user_id)
    RETURNING group_id INTO v_group_id;
  ELSE
    UPDATE friend_groups SET group_name = trim(p_name)
     WHERE group_id = p_group_id AND user_id = v_user_id
    RETURNING group_id INTO v_group_id;
    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'That group no longer exists.';
    END IF;
    DELETE FROM group_members WHERE group_id = v_group_id;
  END IF;

  INSERT INTO group_members (group_id, contact_id)
  SELECT DISTINCT v_group_id, id FROM unnest(v_ids) AS id;

  RETURN v_group_id;
END $$;

-- Delete one of your groups. The contacts in it are kept; only the group and its member list go.
CREATE OR REPLACE FUNCTION delete_group(p_group_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM friend_groups WHERE group_id = p_group_id AND user_id = app_user_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That group no longer exists.';
  END IF;
END $$;

-- 7) Functions: signed-in people only. The rules above call the "owns" checks, so they need access.
REVOKE ALL ON FUNCTION app_user_id(), owns_contact(integer), owns_group(integer), owns_event(integer),
  owns_receipt(integer), owns_item(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_user_id(), owns_contact(integer), owns_group(integer), owns_event(integer),
  owns_receipt(integer), owns_item(integer) TO authenticated;
REVOKE ALL ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_contact(integer, text, text, text, jsonb), delete_contact(integer) TO authenticated;
REVOKE ALL ON FUNCTION save_group(integer, text, integer[]), delete_group(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_group(integer, text, integer[]), delete_group(integer) TO authenticated;
