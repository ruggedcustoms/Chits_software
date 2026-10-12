-- Test data for development only. Made-up people; never load real member data here.
-- The group and auction follow the worked example in docs/requirements-and-design.md:
-- chit Rs 5,00,000, 20 tickets, commission 5%, GST 18%, winning bid Rs 1,00,000.
-- Money is in paise (Rs 1 = 100).

INSERT INTO companies (id, name, owner_name, city, state) VALUES
  ('co_demo', 'Demo Chits Pvt Ltd', 'Demo Owner', 'Bengaluru', 'Karnataka');

INSERT INTO branches (id, company_id, name) VALUES
  ('br_main', 'co_demo', 'Main branch');

INSERT INTO roles (id, company_id, name, is_system, perms_json) VALUES
  ('r_admin', 'co_demo', 'Admin', 1, '{"all":true}'),
  ('r_mgr', 'co_demo', 'Manager', 0, '{"dash":true,"groups":true,"members":true,"enroll":true,"accounts":true,"auctions":true,"payable":true,"receipts":true,"reports":true,"cancelRc":true}'),
  ('r_acc', 'co_demo', 'Accountant', 0, '{"dash":true,"accounts":true,"payable":true,"receipts":true,"reports":true}'),
  ('r_clerk', 'co_demo', 'Collection clerk', 0, '{"dash":true,"members":true,"receipts":true}');

INSERT INTO persons (id, company_id, branch_id, member_no, name, relation_type, relation_name, gender, roles_json, entry_date) VALUES
  ('p_1', 'co_demo', 'br_main', 1, 'Test Member One', 'S/o', 'Test Father', 'Male', '["Member"]', '2026-01-05'),
  ('p_2', 'co_demo', 'br_main', 2, 'Test Member Two', 'W/o', 'Test Husband', 'Female', '["Member"]', '2026-01-05'),
  ('p_3', 'co_demo', 'br_main', 3, 'Test Member Three', 'S/o', 'Test Father', 'Male', '["Member","Guarantor"]', '2026-01-06'),
  ('p_ag', 'co_demo', 'br_main', 4, 'Test Agent', NULL, NULL, 'Male', '["Collection agent","Business agent"]', '2026-01-01');

INSERT INTO person_addresses (person_id, kind, city, state, pin, mobile) VALUES
  ('p_1', 'residential', 'Bengaluru', 'Karnataka', '560001', '9000000001'),
  ('p_2', 'residential', 'Bengaluru', 'Karnataka', '560002', '9000000002'),
  ('p_3', 'residential', 'Bengaluru', 'Karnataka', '560003', '9000000003'),
  ('p_ag', 'residential', 'Bengaluru', 'Karnataka', '560004', '9000000004');

INSERT INTO chit_groups (id, company_id, branch_id, name, chit_amount, installments, start_date, termination_date,
  enrolment_fee, commission_bp, max_bid_bp, gst_bp, late_fee_nps_bp, late_fee_ps_bp, auction_method, auction_day) VALUES
  ('g_demo', 'co_demo', 'br_main', 'DEMO-20', 50000000, 20, '2026-02-01', '2027-09-30',
   0, 500, 4000, 1800, 200, 200, 'both', 10);

INSERT INTO enrollments (id, company_id, group_id, ticket_no, person_id, is_company, enrolment_date, collection_agent_id, business_agent_id, guarantor1_id) VALUES
  ('e_1', 'co_demo', 'g_demo', 1, 'p_1', 0, '2026-01-20', 'p_ag', 'p_ag', 'p_3'),
  ('e_2', 'co_demo', 'g_demo', 2, 'p_2', 0, '2026-01-20', 'p_ag', 'p_ag', 'p_3'),
  ('e_3', 'co_demo', 'g_demo', 3, 'p_3', 0, '2026-01-21', 'p_ag', 'p_ag', NULL),
  ('e_20', 'co_demo', 'g_demo', 20, NULL, 1, '2026-01-20', NULL, NULL, NULL);

-- Auction 1, won by ticket 2 with a bid of Rs 1,00,000.
INSERT INTO auctions (id, company_id, group_id, auction_no, auction_date, due_date, winner_enrollment_id, winner_ticket_no,
  decided_by, bid, commission, gst_bp, gst, bid_payable, net_prize, dividend_pool, dividend_per_ticket, net_payable_per_ticket) VALUES
  ('a_1', 'co_demo', 'g_demo', 1, '2026-02-10', '2026-02-25', 'e_2', 2,
   'bidding', 10000000, 2500000, 1800, 450000, 40000000, 39550000, 7500000, 375000, 2125000);

-- Ticket 1 pays installment 1: Rs 25,000 - Rs 3,750 dividend = Rs 21,250.
INSERT INTO receipts (id, company_id, receipt_no, receipt_date, mode, group_id, enrollment_id, person_id, collection_agent_id, amount) VALUES
  ('rc_1', 'co_demo', 1, '2026-02-20', 'Cash', 'g_demo', 'e_1', 'p_1', 'p_ag', 2125000);
INSERT INTO receipt_installments (receipt_id, installment_no, amount) VALUES ('rc_1', 1, 2125000);

INSERT INTO counters (company_id, name, value) VALUES
  ('co_demo', 'member_no', 4),
  ('co_demo', 'receipt_no', 1);
