-- Deleting a location, a permission of its own (LATER_CHANGES_PLAN.md §7.21,
-- PR 450; ROLES_PLAN.md's permission table): locations.delete, beside
-- locations.archive. Every role holding Archive and restore locations is given
-- it, at the company's scope, so whoever may archive locations may delete them
-- too until it's unticked; the built-in Admin role among them. The holders of
-- each role it changes reload their grants once. Run again, it changes nothing.
WITH given AS (
    INSERT INTO "RoleGrant" ("roleId", "permission", "scope")
    SELECT g."roleId", 'locations.delete', 'COMPANY'::"PermissionScope"
    FROM "RoleGrant" g WHERE g."permission" = 'locations.archive'
    ON CONFLICT ("roleId", "permission") DO NOTHING
    RETURNING "roleId"
)
UPDATE "Role" SET "version" = "version" + 1, "updatedAt" = now() WHERE "id" IN (SELECT "roleId" FROM given);

-- Each role template naming Archive and restore locations, so a role made from
-- it later deletes them too. Once: a template naming it already is left as it is.
UPDATE "RoleTemplate" t
SET "grants" = t."grants"::jsonb || jsonb_build_array(jsonb_build_object('permission', 'locations.delete', 'scope', 'COMPANY')),
    "updatedAt" = now()
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t."grants"::jsonb) e WHERE e->>'permission' = 'locations.archive')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t."grants"::jsonb) e WHERE e->>'permission' = 'locations.delete');
