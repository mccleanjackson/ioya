-- IOYA sample data. Run AFTER schema.sql (it expects empty tables).
-- The app always acts as user 1 (Demo Payer); contact 1 is that user's own row and shows as "You".
-- Participants with an empty paid_method_id still owe money: Mom and Bro (Sunday brunch) and Fred (Grocery run).

INSERT INTO users (user_id, user_first_name, user_last_name, phone) VALUES
  (1, 'Demo', 'Payer', '(555) 100-2000'),
  (2, 'Sam', 'Rivera', '(555) 100-2001'),
  (3, 'Casey', 'Nguyen', '(555) 100-2002');

INSERT INTO contacts (contact_id, cont_first_name, cont_last_name, phone, user_id) VALUES
  (1, 'Demo', 'Payer', '(555) 100-2000', 1),
  (2, 'Fred', 'Kim', '(555) 410-1101', 1),
  (3, 'Dad', 'Payer', '(555) 201-4417', 1),
  (4, 'Mom', 'Payer', '(555) 201-4418', 1),
  (5, 'Bro', 'Payer', '(555) 201-4419', 1),
  (6, 'Johnny', 'White', '(555) 410-2202', 1),
  (7, 'Joe', 'Martinez', '(555) 384-0192', 1),
  (8, 'Priya', 'Shah', '(555) 733-2050', 1),
  (9, 'Sam', 'Rivera', '(555) 100-2001', 2),
  (10, 'Casey', 'Nguyen', '(555) 100-2002', 3);

INSERT INTO friend_groups (group_id, group_name) VALUES
  (1, 'Family'),
  (2, 'Lunch crew'),
  (3, 'Roommates');

INSERT INTO group_members (group_id, contact_id) VALUES
  (1, 3),
  (1, 4),
  (1, 5),
  (2, 2),
  (2, 7),
  (2, 8),
  (3, 2),
  (3, 6);

INSERT INTO payment_methods (pay_method_id, pay_method_name) VALUES
  (1, 'Venmo'),
  (2, 'PayPal'),
  (3, 'Zelle'),
  (4, 'Cash');

INSERT INTO contacts_payment_method (contact_id, pay_method_id, pay_method_username, is_preferred) VALUES
  (1, 1, '@demo-payer', true),
  (2, 1, '@fred-kim', true),
  (3, 1, '@papa-payer', true),
  (3, 3, '(555) 201-4417', false),
  (4, 1, '@mom-payer', true),
  (5, 1, '@bro-payer', true),
  (6, 2, 'johnny.white@example.com', true),
  (7, 3, '(555) 384-0192', true),
  (8, 1, '@priya-shah', true),
  (8, 2, 'priya.shah@example.com', false),
  (9, 1, '@sam-rivera', true),
  (10, 2, 'casey.n@example.com', true);

INSERT INTO events (event_id, event_name) VALUES
  (1, 'Sunday brunch'),
  (2, 'Ramen night'),
  (3, 'Grocery run');

INSERT INTO receipts (receipt_id, event_id, payer_user_id, merchant_name, receipt_date, tax_cents, fees_cents, tip_percent, tip_cents, total_cents) VALUES
  (1, 1, 1, 'Top Cafe', '2026-09-16', 720, 0, 18, 1672, 10010),
  (2, 2, 1, 'Sakura Ramen', '2026-09-11', 480, 0, 20, 1238, 6670),
  (3, 3, 1, 'Trader Joe''s', '2026-09-04', 0, 0, 0, 0, 6624);

INSERT INTO line_items (item_id, receipt_id, description, price_cents, position) VALUES
  (1, 1, 'Avocado toast', 1150, 1),
  (2, 1, 'Breakfast burrito', 1325, 2),
  (3, 1, 'Belgian waffle', 1095, 3),
  (4, 1, 'Eggs Benedict', 1450, 4),
  (5, 1, 'Chicken & waffles', 1395, 5),
  (6, 1, 'Veggie omelet', 1225, 6),
  (7, 1, 'Cinnamon roll (shared)', 650, 7),
  (8, 1, 'Cold brew x2', 1000, 8),
  (9, 2, 'Tonkotsu ramen', 1595, 1),
  (10, 2, 'Spicy miso ramen', 1650, 2),
  (11, 2, 'Shoyu ramen', 1495, 3),
  (12, 2, 'Pork gyoza', 850, 4),
  (13, 2, 'Edamame', 600, 5),
  (14, 3, 'Groceries (yours)', 2450, 1),
  (15, 3, 'Groceries (Fred''s)', 2875, 2),
  (16, 3, 'Paper towels (shared)', 1299, 3);

INSERT INTO participants (contact_id, event_id, paid_method_id) VALUES
  (1, 1, NULL),
  (2, 1, 1),
  (3, 1, 1),
  (4, 1, NULL),
  (5, 1, NULL),
  (6, 1, 2),
  (1, 2, NULL),
  (7, 2, 3),
  (8, 2, 1),
  (1, 3, NULL),
  (2, 3, NULL);

INSERT INTO item_assignments (contact_id, item_id, share_cents) VALUES
  (1, 1, 1150),
  (2, 2, 1325),
  (3, 3, 1095),
  (4, 4, 1450),
  (5, 5, 1395),
  (6, 6, 1225),
  (1, 7, 109),
  (2, 7, 109),
  (3, 7, 108),
  (4, 7, 108),
  (5, 7, 108),
  (6, 7, 108),
  (1, 8, 500),
  (2, 8, 500),
  (1, 9, 1595),
  (7, 10, 1650),
  (8, 11, 1495),
  (1, 12, 284),
  (7, 12, 283),
  (8, 12, 283),
  (7, 13, 300),
  (8, 13, 300),
  (1, 14, 2450),
  (2, 15, 2875),
  (1, 16, 650),
  (2, 16, 649);

-- Explicit ids were used above, so move each id counter past them.
SELECT setval(pg_get_serial_sequence('users', 'user_id'), (SELECT max(user_id) FROM users));
SELECT setval(pg_get_serial_sequence('contacts', 'contact_id'), (SELECT max(contact_id) FROM contacts));
SELECT setval(pg_get_serial_sequence('friend_groups', 'group_id'), (SELECT max(group_id) FROM friend_groups));
SELECT setval(pg_get_serial_sequence('payment_methods', 'pay_method_id'), (SELECT max(pay_method_id) FROM payment_methods));
SELECT setval(pg_get_serial_sequence('events', 'event_id'), (SELECT max(event_id) FROM events));
SELECT setval(pg_get_serial_sequence('receipts', 'receipt_id'), (SELECT max(receipt_id) FROM receipts));
SELECT setval(pg_get_serial_sequence('line_items', 'item_id'), (SELECT max(item_id) FROM line_items));
