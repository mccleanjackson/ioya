-- IOYA: save a finished split to History from the app (Payment requests → Save to History).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after private-data.sql (app_user_id()).
--
-- save_my_split(p_split) saves one split for the signed-in person (guests too) in one step: the event,
-- its receipt (they are the payer), the items, each person's exact share of each item (as the split
-- screens worked it out, so History matches the payment requests), and everyone on it as "not paid yet".
-- Everyone must be one of the caller's own contacts; the caller's "You" contact is always on it.
-- p_split.client_key is a random id the app makes for each split: saving the same split again (a double
-- tap, or a reload while saving) returns the split that was already saved instead of making a copy.
-- The browser still can't write to these tables directly; this function is the only way in.

ALTER TABLE events ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS events_client_key ON events (client_key);

-- p_split looks like:
--   {"client_key": "s-4f9c2a…", "name": "Split on Nov 11", "merchant": "Sakura Ramen", "date": "2026-11-11",
--    "tax_cents": 480, "fees_cents": 0, "tip_cents": 1238, "tip_percent": 20, "total_cents": 6670,
--    "items": [{"description": "Gyoza", "price_cents": 850, "shares": [{"contact_id": 7, "share_cents": 425}, …]}, …]}
-- total_cents is the total printed on the receipt (items + tax + fees, before tip). Returns the event_id.
CREATE OR REPLACE FUNCTION save_my_split(p_split jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user     constant integer := app_user_id();
  v_key      constant text := nullif(trim(coalesce(p_split->>'client_key', '')), '');
  v_name     constant text := trim(coalesce(p_split->>'name', ''));
  v_merchant constant text := trim(coalesce(p_split->>'merchant', ''));
  v_items    constant jsonb := CASE WHEN jsonb_typeof(p_split->'items') = 'array' THEN p_split->'items' ELSE '[]'::jsonb END;
  v_me       users%ROWTYPE;
  v_self     integer;
  v_date     date;
  v_tax      integer;
  v_fees     integer;
  v_tip      integer;
  v_tip_pct  numeric;
  v_total    integer;
  v_price    integer;
  v_sum      bigint;
  v_event    integer;
  v_receipt  integer;
  v_item     jsonb;
  v_item_id  integer;
  v_pos      integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF v_key IS NULL OR length(v_key) > 64 THEN
    RAISE EXCEPTION 'This split is missing its save key. Refresh the page and try again.';
  END IF;
  -- Already saved (a second tap, or a retry after a lost answer): return that split.
  SELECT e.event_id INTO v_event FROM events e WHERE e.client_key = v_key;
  IF v_event IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM receipts r WHERE r.event_id = v_event AND r.payer_user_id = v_user) THEN RETURN v_event; END IF;
    RAISE EXCEPTION 'This split couldn''t be saved. Refresh the page and try again.';
  END IF;

  IF v_name = '' OR length(v_name) > 80 THEN RAISE EXCEPTION 'The split needs a name of at most 80 characters.'; END IF;
  IF v_merchant = '' THEN RAISE EXCEPTION 'Add the store or restaurant name before saving. Tap Edit split to add it.'; END IF;
  IF length(v_merchant) > 80 THEN RAISE EXCEPTION 'The store name can be at most 80 characters. Tap Edit split to shorten it.'; END IF;
  BEGIN
    v_date := (p_split->>'date')::date;
    v_tax  := coalesce((p_split->>'tax_cents')::integer, 0);
    v_fees := coalesce((p_split->>'fees_cents')::integer, 0);
    v_tip  := coalesce((p_split->>'tip_cents')::integer, 0);
    v_tip_pct := coalesce((p_split->>'tip_percent')::numeric, 0);
    v_total := (p_split->>'total_cents')::integer;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Some amounts in this split aren''t valid. Tap Edit split to check them.';
  END;
  IF v_date IS NULL OR v_date < date '2000-01-01' OR v_date > current_date + 2 THEN RAISE EXCEPTION 'The split''s date isn''t valid.'; END IF;
  IF v_total IS NULL OR least(v_tax, v_fees, v_tip, v_total) < 0 OR greatest(v_tax, v_fees, v_tip, v_total) > 10000000
     OR v_tip_pct < 0 OR v_tip_pct > 999.99 THEN
    RAISE EXCEPTION 'Some amounts in this split aren''t valid. Tap Edit split to check them.';
  END IF;

  SELECT * INTO v_me FROM users WHERE users.user_id = v_user;
  SELECT c.contact_id INTO v_self FROM contacts c
   WHERE c.user_id = v_user AND c.cont_first_name = v_me.user_first_name
     AND c.cont_last_name = v_me.user_last_name AND c.phone IS NOT DISTINCT FROM v_me.phone
   ORDER BY c.contact_id LIMIT 1;

  IF jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one item before saving.'; END IF;
  IF jsonb_array_length(v_items) > 200 THEN RAISE EXCEPTION 'A split can have at most 200 items.'; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_pos := v_pos + 1;
    IF trim(coalesce(v_item->>'description', '')) = '' THEN RAISE EXCEPTION 'Item % needs a name. Tap Edit split to add it.', v_pos; END IF;
    IF length(trim(v_item->>'description')) > 100 THEN RAISE EXCEPTION 'Item %''s name is too long (100 characters at most). Tap Edit split to shorten it.', v_pos; END IF;
    BEGIN
      v_price := (v_item->>'price_cents')::integer;
    EXCEPTION WHEN others THEN v_price := NULL;
    END;
    IF v_price IS NULL OR v_price < 0 OR v_price > 10000000 THEN RAISE EXCEPTION 'Item % has a price that isn''t valid. Tap Edit split to fix it.', v_pos; END IF;
    IF jsonb_typeof(v_item->'shares') <> 'array' THEN RAISE EXCEPTION 'Item % is missing who shares it.', v_pos; END IF;
    IF v_price > 0 AND jsonb_array_length(v_item->'shares') = 0 THEN RAISE EXCEPTION 'Item % isn''t assigned to anyone. Tap Edit split to assign it.', v_pos; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_item->'shares') s
                WHERE jsonb_typeof(s->'contact_id') <> 'number' OR jsonb_typeof(s->'share_cents') <> 'number'
                   OR (s->>'share_cents')::numeric < 0 OR (s->>'share_cents')::numeric <> floor((s->>'share_cents')::numeric)
                   OR NOT EXISTS (SELECT 1 FROM contacts c WHERE c.contact_id = (s->>'contact_id')::integer AND c.user_id = v_user)) THEN
      RAISE EXCEPTION 'Someone on item % is no longer in your contacts. Tap Edit split to check who''s on it.', v_pos;
    END IF;
    IF (SELECT count(DISTINCT s->>'contact_id') FROM jsonb_array_elements(v_item->'shares') s) < jsonb_array_length(v_item->'shares') THEN
      RAISE EXCEPTION 'Item % lists someone twice.', v_pos;
    END IF;
    SELECT coalesce(sum((s->>'share_cents')::bigint), 0) INTO v_sum FROM jsonb_array_elements(v_item->'shares') s;
    IF jsonb_array_length(v_item->'shares') > 0 AND v_sum <> v_price THEN
      RAISE EXCEPTION 'Item %''s shares don''t add up to its price. Tap Edit split to check it.', v_pos;
    END IF;
  END LOOP;

  BEGIN
    INSERT INTO events (event_name, client_key) VALUES (v_name, v_key) RETURNING events.event_id INTO v_event;
  EXCEPTION WHEN unique_violation THEN
    -- Saved by another tab a moment ago.
    SELECT e.event_id INTO v_event FROM events e JOIN receipts r ON r.event_id = e.event_id
     WHERE e.client_key = v_key AND r.payer_user_id = v_user LIMIT 1;
    IF v_event IS NULL THEN RAISE EXCEPTION 'This split couldn''t be saved. Refresh the page and try again.'; END IF;
    RETURN v_event;
  END;
  INSERT INTO receipts (event_id, payer_user_id, merchant_name, receipt_date, tax_cents, fees_cents, tip_percent, tip_cents, total_cents)
  VALUES (v_event, v_user, v_merchant, v_date, v_tax, v_fees, round(v_tip_pct, 2), v_tip, v_total) RETURNING receipts.receipt_id INTO v_receipt;

  v_pos := 0;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_pos := v_pos + 1;
    INSERT INTO line_items (receipt_id, description, price_cents, position)
    VALUES (v_receipt, trim(v_item->>'description'), (v_item->>'price_cents')::integer, v_pos) RETURNING line_items.item_id INTO v_item_id;
    INSERT INTO item_assignments (contact_id, item_id, share_cents)
    SELECT (s->>'contact_id')::integer, v_item_id, (s->>'share_cents')::integer FROM jsonb_array_elements(v_item->'shares') s;
  END LOOP;

  INSERT INTO participants (contact_id, event_id, paid_method_id)
  SELECT DISTINCT id, v_event, NULL::integer
    FROM (SELECT (s->>'contact_id')::integer AS id FROM jsonb_array_elements(v_items) i, jsonb_array_elements(i->'shares') s
          UNION SELECT v_self WHERE v_self IS NOT NULL) x;
  RETURN v_event;
END $$;

REVOKE ALL ON FUNCTION save_my_split(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_my_split(jsonb) TO authenticated;
