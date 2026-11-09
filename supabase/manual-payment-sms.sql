-- Apply after the manual payment request migrations. Safe to re-run.
-- Keep the ledger independent of contact deletion so attempts still count toward the daily cap.
CREATE TABLE IF NOT EXISTS public.manual_payment_sms (
  request_id uuid PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  phone text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'rejected')),
  sid text,
  proof text
);
CREATE INDEX IF NOT EXISTS manual_payment_sms_owner_attempt
  ON public.manual_payment_sms(auth_user_id, attempted_at);
ALTER TABLE public.manual_payment_sms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read own text submission ledger" ON public.manual_payment_sms;
CREATE POLICY "Read own text submission ledger" ON public.manual_payment_sms
  FOR SELECT TO authenticated USING (auth_user_id = (SELECT auth.uid()));
REVOKE ALL ON public.manual_payment_sms FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_manual_payment_sms(p_id uuid, p_phone text, p_attempt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_auth uuid := auth.uid();
  v_user integer := public.app_user_id();
  v_payee text;
  v_record public.manual_payment_sms%ROWTYPE;
BEGIN
  IF v_auth IS NULL OR v_user IS NULL OR coalesce(auth.jwt()->>'is_anonymous', 'false') = 'true' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sign in to send a text.';
  END IF;
  IF p_phone IS NULL OR p_phone !~ '^\+1[2-9][0-9]{9}$' OR p_attempt IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter a valid U.S. mobile number.';
  END IF;
  PERFORM pg_advisory_xact_lock(1369412160, hashtext(v_auth::text));
  SELECT r.data->>'payeeName' INTO v_payee
    FROM public.manual_payment_requests r
   WHERE r.id = p_id AND r.user_id = v_user AND r.expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'This payment request is unavailable or has expired.';
  END IF;
  SELECT * INTO v_record FROM public.manual_payment_sms WHERE request_id = p_id AND auth_user_id = v_auth;
  IF FOUND THEN
    RETURN jsonb_build_object('status', v_record.status, 'phone', v_record.phone, 'sid', v_record.sid, 'proof', v_record.proof);
  END IF;
  DELETE FROM public.manual_payment_sms WHERE auth_user_id = v_auth AND attempted_at <= now() - interval '7 days';
  IF (SELECT count(*) FROM public.manual_payment_sms WHERE auth_user_id = v_auth
      AND attempted_at > now() - interval '1 day') >= 25 THEN
    RAISE EXCEPTION USING ERRCODE = '54000', MESSAGE = 'Daily text limit reached.';
  END IF;
  INSERT INTO public.manual_payment_sms(request_id, auth_user_id, attempt_id, phone)
  VALUES (p_id, v_auth, p_attempt, p_phone);
  RETURN jsonb_build_object('status', 'reserved', 'payeeName', v_payee);
END $$;

CREATE OR REPLACE FUNCTION public.finish_manual_payment_sms(p_id uuid, p_attempt uuid, p_sid text, p_proof text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (p_sid IS NULL) <> (p_proof IS NULL) OR
      (p_sid IS NOT NULL AND (p_sid !~* '^SM[0-9a-f]{32}$' OR p_proof !~ '^[0-9a-f]{64}$')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid text submission receipt.';
  END IF;
  UPDATE public.manual_payment_sms
    SET status = CASE WHEN p_sid IS NULL THEN 'rejected' ELSE 'submitted' END, sid = p_sid, proof = p_proof
    WHERE request_id = p_id AND auth_user_id = auth.uid() AND attempt_id = p_attempt AND status = 'pending';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.reserve_manual_payment_sms(uuid, text, uuid),
  public.finish_manual_payment_sms(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_manual_payment_sms(uuid, text, uuid),
  public.finish_manual_payment_sms(uuid, uuid, text, text) TO authenticated;
