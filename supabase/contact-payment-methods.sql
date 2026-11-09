-- Enable saved Cash App and Apple Cash accounts for contacts.
-- Apply once to an existing database. Safe to run again.
DO $$
DECLARE
  next_id integer;
  method text;
  id_sequence regclass := pg_get_serial_sequence('public.payment_methods', 'pay_method_id')::regclass;
BEGIN
  LOCK TABLE public.payment_methods IN SHARE ROW EXCLUSIVE MODE;
  SELECT greatest(4, coalesce(max(pay_method_id), 0), coalesce(pg_sequence_last_value(id_sequence), 0)) + 1
    INTO next_id FROM public.payment_methods;
  FOREACH method IN ARRAY ARRAY['Cash App', 'Apple Cash'] LOOP
    INSERT INTO public.payment_methods(pay_method_id, pay_method_name)
      VALUES (next_id, method) ON CONFLICT (pay_method_name) DO NOTHING;
    IF FOUND THEN next_id := next_id + 1; END IF;
  END LOOP;
  PERFORM setval(id_sequence, next_id - 1, true);
END $$;
