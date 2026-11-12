-- IOYA: "Maintain Splits" for admins (/admin#splits).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after admin-login.sql (is_admin()).
--
-- A split is stored across five tables: events (its name), receipts (payer, merchant, date, tax, fees,
-- tip, printed total), line_items, item_assignments (who shares each item, and their part of its price)
-- and participants (who is on the split, and how they paid; paid_method_id NULL = not paid yet).
-- Every function here starts by checking is_admin(). Admins can:
--   admin_list_splits()   see every split with its receipt, items, shares and people
--   admin_save_split()    add a split, or replace one's details, items and payments, all in one step
--   admin_delete_split()  delete a split (receipt, items, shares and paid records; contacts are kept)
-- Rules: everyone on a split must be one of the payer's contacts; the payer's own "You" contact is
-- always on it; a shared item is split evenly, and leftover cents go to the first people listed
-- (the same rule as the app). Only splits with one receipt can be edited (all the app makes).

CREATE OR REPLACE FUNCTION admin_list_splits()
RETURNS TABLE (event_id integer, event_name text, user_id integer, owner_first text, owner_last text, owner_kind text,
               receipts jsonb, people jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain splits.';
  END IF;
  RETURN QUERY
  SELECT e.event_id, e.event_name::text, u.user_id, u.user_first_name::text, u.user_last_name::text,
         CASE WHEN u.user_id IS NULL THEN NULL
              WHEN u.auth_user_id IS NULL THEN 'none'
              WHEN coalesce(a.is_anonymous, false) THEN 'guest'
              WHEN u.is_admin THEN 'admin' ELSE 'profile' END,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'receipt_id', r.receipt_id, 'payer_user_id', r.payer_user_id, 'merchant_name', r.merchant_name,
                     'receipt_date', r.receipt_date, 'tax_cents', r.tax_cents, 'fees_cents', r.fees_cents,
                     'tip_percent', r.tip_percent, 'tip_cents', r.tip_cents, 'total_cents', r.total_cents,
                     'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                 'item_id', li.item_id, 'description', li.description, 'price_cents', li.price_cents, 'position', li.position,
                                 'shares', coalesce((SELECT jsonb_agg(jsonb_build_object('contact_id', ia.contact_id, 'share_cents', ia.share_cents)
                                                       ORDER BY ia.contact_id)
                                                      FROM item_assignments ia WHERE ia.item_id = li.item_id), '[]'::jsonb))
                                 ORDER BY li.position, li.item_id)
                                FROM line_items li WHERE li.receipt_id = r.receipt_id), '[]'::jsonb))
                     ORDER BY r.receipt_id)
                    FROM receipts r WHERE r.event_id = e.event_id), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(jsonb_build_object('contact_id', c.contact_id, 'first_name', c.cont_first_name,
                     'last_name', c.cont_last_name, 'paid_method_id', p.paid_method_id,
                     'is_self', u.user_id IS NOT NULL AND c.user_id = u.user_id AND c.cont_first_name = u.user_first_name
                                AND c.cont_last_name = u.user_last_name AND c.phone IS NOT DISTINCT FROM u.phone)
                     ORDER BY c.contact_id)
                    FROM participants p JOIN contacts c ON c.contact_id = p.contact_id WHERE p.event_id = e.event_id), '[]'::jsonb)
    FROM events e
    LEFT JOIN users u ON u.user_id = (SELECT r.payer_user_id FROM receipts r WHERE r.event_id = e.event_id ORDER BY r.receipt_id LIMIT 1)
    LEFT JOIN auth.users a ON a.id = u.auth_user_id
   ORDER BY e.event_id;
END $$;

-- Add (p_event_id NULL, paid by user p_user_id) or replace a split. p_split looks like:
--   {"name": "Ramen night", "merchant": "Sakura Ramen", "date": "2026-09-11",
--    "tax_cents": 480, "fees_cents": 0, "tip_cents": 1238, "total_cents": 6670,   (total: NULL = items + tax + fees)
--    "items": [{"description": "Gyoza", "price_cents": 850, "contact_ids": [7, 8]}, …],
--    "paid": {"7": 3, "8": null}}                                                 (contact id → payment method id)
-- Returns the event_id.
CREATE OR REPLACE FUNCTION admin_save_split(p_event_id integer, p_user_id integer, p_split jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name     constant text := trim(coalesce(p_split->>'name', ''));
  v_merchant constant text := trim(coalesce(p_split->>'merchant', ''));
  v_items    constant jsonb := CASE WHEN jsonb_typeof(p_split->'items') = 'array' THEN p_split->'items' ELSE '[]'::jsonb END;
  v_paid     constant jsonb := CASE WHEN jsonb_typeof(p_split->'paid') = 'object' THEN p_split->'paid' ELSE '{}'::jsonb END;
  v_date     date;
  v_tax      integer;
  v_fees     integer;
  v_tip      integer;
  v_total    integer;
  v_sub      bigint;
  v_owner    users%ROWTYPE;
  v_self     integer;
  v_event    integer;
  v_receipt  integer;
  v_item     jsonb;
  v_item_id  integer;
  v_ids      integer[];
  v_price    integer;
  v_pos      integer := 0;
  v_n        integer;
  v_key      text;
  v_method   jsonb;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain splits.';
  END IF;
  IF v_name = '' THEN RAISE EXCEPTION 'Add a split name.'; END IF;
  IF length(v_name) > 80 THEN RAISE EXCEPTION 'Split names can be at most 80 characters.'; END IF;
  IF v_merchant = '' THEN RAISE EXCEPTION 'Add the merchant (where the receipt is from).'; END IF;
  IF length(v_merchant) > 80 THEN RAISE EXCEPTION 'Merchant names can be at most 80 characters.'; END IF;
  BEGIN
    v_date := (p_split->>'date')::date;
  EXCEPTION WHEN others THEN v_date := NULL;
  END;
  IF v_date IS NULL OR v_date < date '2000-01-01' OR v_date > current_date + 366 THEN
    RAISE EXCEPTION 'Enter the receipt date.';
  END IF;
  -- Money is whole cents, at most $100,000.
  BEGIN
    v_tax  := coalesce((p_split->>'tax_cents')::integer, 0);
    v_fees := coalesce((p_split->>'fees_cents')::integer, 0);
    v_tip  := coalesce((p_split->>'tip_cents')::integer, 0);
    v_total := (p_split->>'total_cents')::integer;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Amounts must be in dollars and cents, like 12.50.';
  END;
  IF least(v_tax, v_fees, v_tip, coalesce(v_total, 0)) < 0 OR greatest(v_tax, v_fees, v_tip, coalesce(v_total, 0)) > 10000000 THEN
    RAISE EXCEPTION 'Amounts must be between $0 and $100,000.';
  END IF;

  -- The payer, and their own "You" contact.
  IF p_event_id IS NULL THEN
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'Pick who paid.'; END IF;
    SELECT * INTO v_owner FROM users WHERE users.user_id = p_user_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That payer no longer exists. Refresh the page and try again.'; END IF;
  ELSE
    PERFORM 1 FROM events WHERE events.event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'That split no longer exists. Refresh the page and try again.'; END IF;
    IF (SELECT count(*) FROM receipts r WHERE r.event_id = p_event_id) <> 1 THEN
      RAISE EXCEPTION 'Only splits with exactly one receipt can be edited here.';
    END IF;
    SELECT r.receipt_id INTO v_receipt FROM receipts r WHERE r.event_id = p_event_id;
    SELECT u.* INTO v_owner FROM users u JOIN receipts r ON r.payer_user_id = u.user_id WHERE r.receipt_id = v_receipt;
    IF p_user_id IS NOT NULL AND p_user_id <> v_owner.user_id THEN
      RAISE EXCEPTION 'A split''s payer can''t be changed. Add a new split for the other user instead.';
    END IF;
  END IF;
  SELECT c.contact_id INTO v_self FROM contacts c
   WHERE c.user_id = v_owner.user_id AND c.cont_first_name = v_owner.user_first_name
     AND c.cont_last_name = v_owner.user_last_name AND c.phone IS NOT DISTINCT FROM v_owner.phone
   ORDER BY c.contact_id LIMIT 1;

  -- Items.
  IF jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.'; END IF;
  IF jsonb_array_length(v_items) > 200 THEN RAISE EXCEPTION 'A split can have at most 200 items.'; END IF;
  v_sub := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_pos := v_pos + 1;
    IF trim(coalesce(v_item->>'description', '')) = '' THEN RAISE EXCEPTION 'Item %: add a description.', v_pos; END IF;
    IF length(trim(v_item->>'description')) > 100 THEN RAISE EXCEPTION 'Item %: descriptions can be at most 100 characters.', v_pos; END IF;
    BEGIN
      v_price := (v_item->>'price_cents')::integer;
    EXCEPTION WHEN others THEN v_price := NULL;
    END;
    IF v_price IS NULL OR v_price < 0 OR v_price > 10000000 THEN RAISE EXCEPTION 'Item %: enter a price between $0 and $100,000.', v_pos; END IF;
    v_sub := v_sub + v_price;
    IF jsonb_typeof(v_item->'contact_ids') <> 'array' OR jsonb_array_length(v_item->'contact_ids') = 0 THEN
      RAISE EXCEPTION 'Item %: pick who shares it.', v_pos;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_item->'contact_ids') x
                WHERE x !~ '^[0-9]+$' OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.contact_id = x::integer AND c.user_id = v_owner.user_id)) THEN
      RAISE EXCEPTION 'Item %: everyone must be one of the payer''s contacts. Refresh the page and try again.', v_pos;
    END IF;
  END LOOP;
  IF v_total IS NULL THEN v_total := least(v_sub + v_tax + v_fees, 2147483647); END IF;

  -- Paid: only people on the split, and real payment methods.
  FOR v_key, v_method IN SELECT * FROM jsonb_each(v_paid) LOOP
    IF jsonb_typeof(v_method) = 'null' THEN CONTINUE; END IF;
    IF v_key !~ '^[0-9]+$' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i, jsonb_array_elements_text(i->'contact_ids') x WHERE x = v_key) THEN
      RAISE EXCEPTION 'Only people on the split can be marked as paid.';
    END IF;
    IF v_key::integer = v_self THEN RAISE EXCEPTION 'The payer can''t be marked as paid back.'; END IF;
    IF jsonb_typeof(v_method) <> 'number' OR NOT EXISTS (SELECT 1 FROM payment_methods pm WHERE pm.pay_method_id = (v_method #>> '{}')::integer) THEN
      RAISE EXCEPTION 'One of those payment methods no longer exists. Refresh the page and try again.';
    END IF;
  END LOOP;

  -- Save: the event and receipt, then replace items, shares and people.
  IF p_event_id IS NULL THEN
    INSERT INTO events (event_name) VALUES (v_name) RETURNING events.event_id INTO v_event;
    INSERT INTO receipts (event_id, payer_user_id, merchant_name, receipt_date, tax_cents, fees_cents, tip_percent, tip_cents, total_cents)
    VALUES (v_event, v_owner.user_id, v_merchant, v_date, v_tax, v_fees, 0, v_tip, v_total) RETURNING receipts.receipt_id INTO v_receipt;
  ELSE
    v_event := p_event_id;
    UPDATE events SET event_name = v_name WHERE events.event_id = v_event;
    UPDATE receipts SET merchant_name = v_merchant, receipt_date = v_date, tax_cents = v_tax, fees_cents = v_fees,
           tip_cents = v_tip, total_cents = v_total WHERE receipts.receipt_id = v_receipt;
    DELETE FROM line_items WHERE line_items.receipt_id = v_receipt;  -- their shares go with them
    DELETE FROM participants WHERE participants.event_id = v_event;
  END IF;
  -- Tip as a percent of the items, for display (0 when there are no items to compare to).
  UPDATE receipts SET tip_percent = CASE WHEN v_sub > 0 THEN least(round(v_tip * 100.0 / v_sub, 2), 999.99) ELSE 0 END
   WHERE receipts.receipt_id = v_receipt;

  v_pos := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_pos := v_pos + 1;
    v_price := (v_item->>'price_cents')::integer;
    INSERT INTO line_items (receipt_id, description, price_cents, position)
    VALUES (v_receipt, trim(v_item->>'description'), v_price, v_pos) RETURNING line_items.item_id INTO v_item_id;
    -- People in the order given, without repeats.
    SELECT array_agg(id ORDER BY first_at) INTO v_ids
      FROM (SELECT x::integer AS id, min(ord) AS first_at FROM jsonb_array_elements_text(v_item->'contact_ids') WITH ORDINALITY AS t(x, ord) GROUP BY x::integer) s;
    v_n := array_length(v_ids, 1);
    INSERT INTO item_assignments (contact_id, item_id, share_cents)
    SELECT id, v_item_id, v_price / v_n + CASE WHEN k <= v_price % v_n THEN 1 ELSE 0 END
      FROM unnest(v_ids) WITH ORDINALITY AS t(id, k);
  END LOOP;

  INSERT INTO participants (contact_id, event_id, paid_method_id)
  SELECT DISTINCT ON (id) id, v_event,
         CASE WHEN id = v_self OR jsonb_typeof(v_paid->(id::text)) IS DISTINCT FROM 'number' THEN NULL ELSE (v_paid->>(id::text))::integer END
    FROM (SELECT x::integer AS id FROM jsonb_array_elements(v_items) i, jsonb_array_elements_text(i->'contact_ids') x
          UNION SELECT v_self WHERE v_self IS NOT NULL) s;
  RETURN v_event;
END $$;

-- Delete a split: its receipt(s), items, shares and paid records. Contacts are kept.
CREATE OR REPLACE FUNCTION admin_delete_split(p_event_id integer)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only IOYA admins can maintain splits.';
  END IF;
  DELETE FROM events WHERE events.event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That split no longer exists. Refresh the page and try again.'; END IF;
END $$;

REVOKE ALL ON FUNCTION admin_list_splits(), admin_save_split(integer, integer, jsonb), admin_delete_split(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_list_splits(), admin_save_split(integer, integer, jsonb), admin_delete_split(integer) TO authenticated;
