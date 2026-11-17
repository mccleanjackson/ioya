-- IOYA: the OKR page (/okrs). Tracks the team's 4 key results across the whole app.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after save-splits.sql.
--
-- events.created_at is when a split was saved. participants.paid_at is when the payer pressed
-- "Mark as paid" for that person (cleared again by "Mark as unpaid"). A trigger fills paid_at in, so
-- the app, Save to History and the admin pages need no changes. Splits saved before this file was run
-- have no times: they still count for key results 1 and 2, but not 3 and 4.
-- Note: an admin edit of a split (Maintain → Splits) saves its people again, so anyone already marked
-- paid gets the edit's time as their paid time.
--
-- okr_stats() returns only totals (counts, percentages, an average time). It never returns names,
-- amounts per person or anything about a user, so anyone may call it, signed in or not.

ALTER TABLE events ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE events ALTER COLUMN created_at SET DEFAULT now();   -- older rows stay empty (their time isn't known)
ALTER TABLE participants ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE OR REPLACE FUNCTION set_participant_paid_at()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.paid_method_id IS NULL THEN
    NEW.paid_at := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.paid_method_id IS NULL THEN
    NEW.paid_at := now();
  ELSE
    NEW.paid_at := OLD.paid_at;   -- switching the payment app keeps the original paid time
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS participants_paid_at ON participants;
CREATE TRIGGER participants_paid_at BEFORE INSERT OR UPDATE ON participants
  FOR EACH ROW EXECUTE FUNCTION set_participant_paid_at();

-- The 4 key results. "People" means everyone on a split except the payer's own "You" contact
-- (the payer never pays themselves back). A split counts once it has at least one such person.
--   KR1  % of splits where every person is marked paid.
--   KR2  For splits not fully paid: % of the money owed (item shares + their part of tax, fees
--        and tip) that has been marked paid.
--   KR3  % of people marked paid within 24 hours of the split being saved. People whose split is
--        under 24 hours old and who haven't paid yet still have time, so they aren't counted yet.
--   KR4  Average time from saving a split to marking each person paid.
CREATE OR REPLACE FUNCTION okr_stats()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH people AS (
    SELECT p.event_id, p.contact_id, p.paid_method_id IS NOT NULL AS paid, p.paid_at, e.created_at
      FROM participants p
      JOIN events e ON e.event_id = p.event_id
      JOIN contacts c ON c.contact_id = p.contact_id
     WHERE NOT EXISTS (SELECT 1 FROM receipts r JOIN users u ON u.user_id = r.payer_user_id
                        WHERE r.event_id = p.event_id AND c.user_id = u.user_id
                          AND c.cont_first_name = u.user_first_name AND c.cont_last_name = u.user_last_name
                          AND c.phone IS NOT DISTINCT FROM u.phone)
  ),
  receipt_totals AS (
    SELECT r.receipt_id, r.tax_cents + r.fees_cents + r.tip_cents AS extra,
           (SELECT coalesce(sum(li.price_cents), 0) FROM line_items li WHERE li.receipt_id = r.receipt_id) AS items
      FROM receipts r
  ),
  owed AS (   -- what each person owes on each split, in cents
    SELECT r.event_id, ia.contact_id,
           sum(ia.share_cents + CASE WHEN t.items > 0 THEN t.extra::numeric * ia.share_cents / t.items ELSE 0 END) AS cents
      FROM item_assignments ia
      JOIN line_items li ON li.item_id = ia.item_id
      JOIN receipts r ON r.receipt_id = li.receipt_id
      JOIN receipt_totals t ON t.receipt_id = r.receipt_id
     GROUP BY r.event_id, ia.contact_id
  ),
  splits AS (
    SELECT event_id, bool_and(paid) AS fully_paid FROM people GROUP BY event_id
  ),
  open_money AS (
    SELECT coalesce(sum(o.cents), 0) AS owed_cents,
           coalesce(sum(o.cents) FILTER (WHERE p.paid), 0) AS paid_cents
      FROM people p
      JOIN splits s ON s.event_id = p.event_id AND NOT s.fully_paid
      LEFT JOIN owed o ON o.event_id = p.event_id AND o.contact_id = p.contact_id
  ),
  timed AS (
    SELECT * FROM people
     WHERE created_at IS NOT NULL AND (paid_at IS NOT NULL OR created_at <= now() - interval '24 hours')
  )
  SELECT jsonb_build_object(
    'kr1', jsonb_build_object('splits', (SELECT count(*) FROM splits),
                              'fully_paid', (SELECT count(*) FROM splits WHERE fully_paid)),
    'kr2', jsonb_build_object('splits', (SELECT count(*) FROM splits WHERE NOT fully_paid),
                              'owed_cents', (SELECT round(owed_cents) FROM open_money),
                              'paid_cents', (SELECT round(paid_cents) FROM open_money)),
    'kr3', jsonb_build_object('hours', 24,
                              'people', (SELECT count(*) FROM timed),
                              'on_time', (SELECT count(*) FROM timed
                                           WHERE paid_at IS NOT NULL AND paid_at - created_at <= interval '24 hours')),
    'kr4', jsonb_build_object('paid', (SELECT count(*) FROM people WHERE paid_at IS NOT NULL AND created_at IS NOT NULL),
                              'average_seconds', (SELECT round(avg(extract(epoch FROM greatest(paid_at - created_at, interval '0'))))
                                                    FROM people WHERE paid_at IS NOT NULL AND created_at IS NOT NULL))
  );
$$;

REVOKE ALL ON FUNCTION okr_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION okr_stats() TO anon, authenticated;
