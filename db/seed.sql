-- Re-runnable: existing pools are left untouched.
INSERT INTO pools (operator_id, vehicle_group, location) VALUES
  ('operator-a', 'economy', 'airport'),
  ('operator-a', 'compact', 'airport'),
  ('operator-b', 'economy', 'airport')
ON CONFLICT (operator_id, vehicle_group, location) DO NOTHING;
