-- Apply after manual-payment-requests.sql. Safe to re-run.
CREATE OR REPLACE FUNCTION public.create_manual_payment_request(p_contact_id integer, p_data jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user integer := public.app_user_id();
  v_id uuid;
  v_amount integer;
  v_note text := btrim(p_data->>'note');
  v_name text := btrim(p_data->>'payeeName');
  v_methods jsonb := p_data->'methods';
  v_items jsonb := p_data->'items';
  v_details jsonb;
BEGIN
  IF v_user IS NULL OR NOT public.owns_contact(p_contact_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Select one of your contacts.';
  END IF;
  IF jsonb_typeof(p_data->'amountCents') IS DISTINCT FROM 'number'
    OR NOT coalesce((p_data->>'amountCents') ~ '^[0-9]{1,7}$', false)
    OR jsonb_typeof(p_data->'note') IS DISTINCT FROM 'string' OR char_length(v_note) NOT BETWEEN 1 AND 160
    OR jsonb_typeof(p_data->'payeeName') IS DISTINCT FROM 'string' OR char_length(v_name) NOT BETWEEN 1 AND 80
    OR jsonb_typeof(v_methods) IS DISTINCT FROM 'object' OR v_methods = '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter valid payment request details.';
  END IF;
  v_amount := (p_data->>'amountCents')::integer;
  IF v_amount NOT BETWEEN 1 AND 1000000 OR EXISTS (
    SELECT 1 FROM jsonb_each(v_methods) AS m(method, value)
    WHERE jsonb_typeof(m.value) <> 'string' OR NOT public.valid_manual_payment_account(m.method, m.value #>> '{}', false)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter valid payment request details.';
  END IF;

  v_details := jsonb_build_object('amountCents', v_amount, 'note', v_note, 'payeeName', v_name, 'methods', v_methods);
  IF v_items IS NOT NULL THEN
    IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter a valid item breakdown.';
    END IF;
    IF jsonb_array_length(v_items) NOT BETWEEN 1 AND 100 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_items) AS entry(item)
      WHERE jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
        OR char_length(btrim(item->>'name')) NOT BETWEEN 1 AND 120
        OR jsonb_typeof(item->'amountCents') IS DISTINCT FROM 'number'
        OR NOT coalesce((item->>'amountCents') ~ '^[0-9]{1,7}$', false)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter a valid item breakdown.';
    END IF;
    IF (SELECT sum((item->>'amountCents')::integer)
        FROM jsonb_array_elements(v_items) AS entry(item)) <> v_amount THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The item breakdown must add up to the requested amount.';
    END IF;
    -- Keep only display data, even if a client sends extra properties.
    SELECT jsonb_agg(jsonb_build_object('name', btrim(item->>'name'), 'amountCents', item->'amountCents') ORDER BY position)
      INTO v_items FROM jsonb_array_elements(v_items) WITH ORDINALITY AS entry(item, position);
    v_details := v_details || jsonb_build_object('items', v_items);
  END IF;

  -- Serialize per account so concurrent requests cannot exceed the active-link cap.
  PERFORM pg_advisory_xact_lock(1369412158, v_user);
  DELETE FROM public.manual_payment_requests WHERE user_id = v_user AND expires_at <= now();
  IF (SELECT count(*) FROM public.manual_payment_requests WHERE user_id = v_user) >= 100 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'Too many active payment links.';
  END IF;
  INSERT INTO public.manual_payment_requests(user_id, contact_id, data)
  VALUES (v_user, p_contact_id, v_details)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE TABLE IF NOT EXISTS public.manual_payment_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     integer NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  recipients  jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS manual_payment_groups_owner_expiry
  ON public.manual_payment_groups(user_id, expires_at);
ALTER TABLE public.manual_payment_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read own active manual payment groups" ON public.manual_payment_groups;
CREATE POLICY "Read own active manual payment groups" ON public.manual_payment_groups
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()) AND expires_at > now());
REVOKE ALL ON public.manual_payment_groups FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_manual_payment_group(p_recipients jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user integer := public.app_user_id();
  v_recipients jsonb;
  v_count integer;
  v_contacts integer;
  v_expires timestamptz;
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sign in to manage payment links.';
  END IF;
  IF jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Choose payment links for up to 11 contacts.';
  END IF;
  IF jsonb_array_length(p_recipients) NOT BETWEEN 1 AND 11 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_recipients) AS entry(recipient)
    WHERE jsonb_typeof(recipient->'id') IS DISTINCT FROM 'string'
      OR NOT coalesce((recipient->>'id') ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$', false)
      OR jsonb_typeof(recipient->'name') IS DISTINCT FROM 'string'
      OR char_length(btrim(recipient->>'name')) NOT BETWEEN 1 AND 80
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Choose payment links for up to 11 contacts.';
  END IF;

  PERFORM pg_advisory_xact_lock(1369412158, v_user);
  SELECT count(*), count(DISTINCT r.contact_id), min(r.expires_at),
    jsonb_agg(jsonb_build_object('id', r.id, 'name', btrim(recipient->>'name')) ORDER BY position)
  INTO v_count, v_contacts, v_expires, v_recipients
  FROM jsonb_array_elements(p_recipients) WITH ORDINALITY AS entry(recipient, position)
  JOIN public.manual_payment_requests r ON r.id = (recipient->>'id')::uuid
  WHERE r.user_id = v_user AND r.expires_at > now();

  IF v_count <> jsonb_array_length(p_recipients) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'A payment request is unavailable or has expired.';
  END IF;
  IF v_contacts <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Select each contact only once.';
  END IF;
  DELETE FROM public.manual_payment_groups WHERE user_id = v_user AND expires_at <= now();
  SELECT id INTO v_id FROM public.manual_payment_groups
  WHERE user_id = v_user AND recipients = v_recipients;
  IF FOUND THEN RETURN v_id; END IF;
  IF (SELECT count(*) FROM public.manual_payment_groups WHERE user_id = v_user) >= 100 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'Too many active payment links.';
  END IF;

  INSERT INTO public.manual_payment_groups(user_id, recipients, expires_at)
  VALUES (v_user, v_recipients, v_expires) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.read_manual_payment_group(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_recipients jsonb;
BEGIN
  SELECT jsonb_agg(recipient ORDER BY position) INTO v_recipients
  FROM public.manual_payment_groups g
  CROSS JOIN LATERAL jsonb_array_elements(g.recipients) WITH ORDINALITY AS entry(recipient, position)
  JOIN public.manual_payment_requests r ON r.id = (recipient->>'id')::uuid AND r.user_id = g.user_id
  WHERE g.id = p_id AND g.expires_at > now() AND r.expires_at > now();
  IF v_recipients IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
  END IF;
  RETURN jsonb_build_object('recipients', v_recipients);
END $$;

REVOKE ALL ON FUNCTION public.create_manual_payment_group(jsonb), public.read_manual_payment_group(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_payment_group(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_manual_payment_group(uuid) TO anon, authenticated;
