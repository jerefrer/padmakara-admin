-- Audiences that open an event without requiring an active membership.
-- Slugs are the contract with src/services/access.ts; existing slugs keep their meaning.
INSERT INTO "audiences" ("name_en", "name_pt", "slug", "display_order") VALUES
  ('Anyone with an account', 'Qualquer pessoa com conta', 'account-holders', 2),
  ('User group members (membership not required)', 'Membros do grupo de utilizadores (adesão não obrigatória)', 'retreat-group-members-no-membership', 5),
  ('Event participants (membership not required)', 'Participantes no evento (adesão não obrigatória)', 'event-participants-no-membership', 4)
ON CONFLICT ("slug") DO NOTHING;
