-- Apply after private-data.sql. Safe to re-run. Public access uses unguessable links.
CREATE TABLE IF NOT EXISTS public.manual_payment_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     integer NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  contact_id  integer NOT NULL REFERENCES public.contacts(contact_id) ON DELETE CASCADE,
  data        jsonb NOT NULL,
  consent     jsonb,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS manual_payment_requests_owner_expiry
  ON public.manual_payment_requests(user_id, expires_at);
ALTER TABLE public.manual_payment_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read own active manual payment requests" ON public.manual_payment_requests;
CREATE POLICY "Read own active manual payment requests" ON public.manual_payment_requests
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()) AND expires_at > now());
-- Use the RPCs for app access, including the narrow public capability lookup.
REVOKE ALL ON public.manual_payment_requests FROM PUBLIC, anon, authenticated;

-- Validate here too because a Supabase client can call the functions directly.
CREATE OR REPLACE FUNCTION public.valid_manual_payment_account(
  p_method text, p_value text, p_consent boolean
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $account$
  SELECT coalesce(
    CASE WHEN char_length(p_value) > CASE WHEN p_method = 'applePayUrl' THEN 1000 ELSE 100 END THEN false
    WHEN p_method = 'venmo' THEN p_value ~ '^[A-Za-z0-9_-]{5,30}$'
    WHEN p_method = 'paypal' AND p_value ~ '^[A-Za-z0-9]{1,20}$' THEN true
    WHEN p_method = 'zelle' AND p_value ~ '^\+1[2-9][0-9]{9}$' THEN true
    WHEN p_method = 'zelle' OR (p_method = 'paypal' AND p_consent)
      THEN p_value ~* $pattern$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$$pattern$
    WHEN p_method = 'applePayUrl' AND NOT p_consent
      THEN p_value ~ '^https://(buy|checkout)\.stripe\.com/[A-Za-z0-9_/-]+(#[A-Za-z0-9%=_-]+)?$'
    ELSE false END, false);
$account$;

CREATE OR REPLACE FUNCTION public.create_manual_payment_request(p_contact_id integer, p_data jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user integer := public.app_user_id();
  v_id uuid;
  v_amount integer;
  v_note text := btrim(p_data->>'note');
  v_name text := btrim(p_data->>'payeeName');
  v_methods jsonb := p_data->'methods';
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

  -- Serialize per account so concurrent requests cannot exceed the active-link cap.
  PERFORM pg_advisory_xact_lock(1369412158, v_user);
  DELETE FROM public.manual_payment_requests WHERE user_id = v_user AND expires_at <= now();
  IF (SELECT count(*) FROM public.manual_payment_requests WHERE user_id = v_user) >= 100 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'Too many active payment links.';
  END IF;
  INSERT INTO public.manual_payment_requests(user_id, contact_id, data)
  VALUES (v_user, p_contact_id, jsonb_build_object('amountCents', v_amount, 'note', v_note, 'payeeName', v_name, 'methods', v_methods))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.read_manual_payment_request(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_data jsonb;
BEGIN
  SELECT data INTO v_data FROM public.manual_payment_requests WHERE id = p_id AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
  END IF;
  RETURN v_data;
END $$;

CREATE OR REPLACE FUNCTION public.record_manual_payment_consent(p_id uuid, p_consent jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_method text := p_consent->>'method';
  v_username text := p_consent->>'username';
  v_consent jsonb;
BEGIN
  IF jsonb_typeof(p_consent->'username') IS DISTINCT FROM 'string'
    OR NOT public.valid_manual_payment_account(v_method, v_username, true) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter a valid payment account.';
  END IF;
  v_consent := jsonb_build_object('method', v_method, 'username', v_username);
  UPDATE public.manual_payment_requests SET consent = v_consent
  WHERE id = p_id AND expires_at > now() AND (consent IS NULL OR consent = v_consent);
  IF FOUND THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.manual_payment_requests WHERE id = p_id AND expires_at > now()) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Payment details have already been shared for this link.';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
END $$;

CREATE OR REPLACE FUNCTION public.read_manual_payment_consent(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_consent jsonb;
BEGIN
  SELECT consent INTO v_consent FROM public.manual_payment_requests
  WHERE id = p_id AND user_id = public.app_user_id() AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
  END IF;
  RETURN v_consent;
END $$;

CREATE OR REPLACE FUNCTION public.save_manual_payment_consent(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_contact_id integer;
  v_consent jsonb;
  v_method_id integer;
  v_saved text;
BEGIN
  -- Lock the contact so concurrent contact edits and consent saves serialize.
  SELECT c.contact_id, r.consent INTO v_contact_id, v_consent
  FROM public.manual_payment_requests r
  JOIN public.contacts c ON c.contact_id = r.contact_id AND c.user_id = r.user_id
  WHERE r.id = p_id AND r.user_id = public.app_user_id() AND r.expires_at > now()
  FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
  END IF;
  IF v_consent IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'This contact has not shared an account.';
  END IF;
  SELECT pay_method_id INTO v_method_id FROM public.payment_methods
  WHERE lower(pay_method_name) = v_consent->>'method';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'This payment method is unavailable in Contacts.';
  END IF;

  INSERT INTO public.contacts_payment_method (contact_id, pay_method_id, pay_method_username)
  VALUES (v_contact_id, v_method_id, v_consent->>'username')
  ON CONFLICT (contact_id, pay_method_id) DO NOTHING;
  SELECT pay_method_username INTO v_saved FROM public.contacts_payment_method
  WHERE contact_id = v_contact_id AND pay_method_id = v_method_id;
  IF v_saved IS DISTINCT FROM (v_consent->>'username') THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'This contact already has a different account for that payment method.';
  END IF;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.valid_manual_payment_account(text, text, boolean),
  public.create_manual_payment_request(integer, jsonb), public.read_manual_payment_consent(uuid),
  public.save_manual_payment_consent(uuid),
  public.read_manual_payment_request(uuid), public.record_manual_payment_consent(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_payment_request(integer, jsonb),
  public.read_manual_payment_consent(uuid), public.save_manual_payment_consent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_manual_payment_request(uuid),
  public.record_manual_payment_consent(uuid, jsonb) TO anon, authenticated;
