import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { locationActions } from "@/lib/locations"
import { KNOWN_REFUSALS } from "@/lib/api-errors"
import { AUDIT_ACTIONS } from "@/lib/audit-codes"
import { PERMISSIONS, CATALOGUE_VERSION } from "@/lib/permissions/catalogue"
import { BUILT_IN_GRANTS } from "@/lib/permissions/built-in"
import { stripComments } from "./strip-comments"
import { en } from "./translations/en"
import { ar } from "./translations/ar"

/**
 * Deleting a location no task has used (LATER_CHANGES_PLAN.md §7.21;
 * DESIGN.md §5.5, Row menu): when the row menu offers it, its permission of
 * its own, the route, the list's dialog and what it says, and the words in
 * both languages. What the server does is lib/locations-delete.db.test.ts's.
 */

const read = (file: string) => stripComments(readFileSync(file, "utf8"))
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, "")

describe("the row menu", () => {
    const branch = { archivedAt: null, isHq: false, client: { id: "v-1" }, inUse: false }
    const all = { edit: true, archive: true, delete: true }

    it("offers Delete last, after Archive, for one no task has used, with locations.delete", () => {
        expect(locationActions(branch, all)).toEqual(["edit", "hq", "archive", "delete"])
        expect(locationActions({ ...branch, client: null }, all)).toEqual(["edit", "archive", "delete"])
        expect(locationActions(branch, { edit: false, archive: true, delete: true })).toEqual(["archive", "delete"])
    })

    it("is a permission of its own: Delete without Archive, and Archive without Delete", () => {
        expect(locationActions(branch, { edit: false, archive: false, delete: true })).toEqual(["delete"])
        expect(locationActions(branch, { edit: true, archive: false, delete: true })).toEqual(["edit", "hq", "delete"])
        expect(locationActions(branch, { edit: true, archive: true, delete: false })).toEqual(["edit", "hq", "archive"])
        expect(locationActions(branch, { edit: true, archive: false, delete: false })).toEqual(["edit", "hq"])
    })

    it("offers it after Restore once archived, for whoever holds its own", () => {
        const archived = { ...branch, archivedAt: "2026-11-01" }
        expect(locationActions(archived, all)).toEqual(["restore", "delete"])
        expect(locationActions(archived, { edit: false, archive: false, delete: true })).toEqual(["delete"])
        expect(locationActions(archived, { edit: false, archive: true, delete: false })).toEqual(["restore"])
        expect(locationActions({ ...archived, inUse: true }, all)).toEqual(["restore"])
        expect(locationActions(archived, { edit: true, archive: false, delete: false })).toEqual([])
    })

    it("never offers it for one a task has used, one not known to be unused, or a client's HQ", () => {
        expect(locationActions({ ...branch, inUse: true }, all)).toEqual(["edit", "hq", "archive"])
        const unknown = { archivedAt: null, isHq: false, client: { id: "v-1" } }
        expect(locationActions(unknown, all)).toEqual(["edit", "hq", "archive"])
        expect(locationActions({ ...branch, isHq: true }, all)).toEqual(["edit"])
        expect(locationActions({ ...branch, isHq: true }, { edit: false, archive: false, delete: true })).toEqual([])
    })
})

describe("the permission", () => {
    it("is Delete locations, code 96, for the company, beside Archive and restore locations, and not high-risk", () => {
        expect(PERMISSIONS["locations.delete"]).toEqual({ code: 96, module: "CLIENTS", scopes: ["COMPANY"], implies: ["locations.view"] })
        expect(PERMISSIONS["locations.archive"]).toEqual({ code: 80, module: "CLIENTS", scopes: ["COMPANY"], implies: ["locations.view"] })
        expect(CATALOGUE_VERSION).toBe(17)
    })

    it("is an Admin's, and never a Team Leader's or an Employee's", () => {
        expect(BUILT_IN_GRANTS.ADMIN["locations.delete"]).toBe("COMPANY")
        expect(BUILT_IN_GRANTS.TEAM_LEADER).not.toHaveProperty("locations.delete")
        expect(BUILT_IN_GRANTS.EMPLOYEE).not.toHaveProperty("locations.delete")
    })

    it("is given by its migration to every role and template holding locations.archive, once, and the roles it changes reload", () => {
        const sql = stripSqlComments(readFileSync("prisma/migrations/20270202000000_location_delete_permission/migration.sql", "utf8"))
        expect(sql).toContain(`SELECT g."roleId", 'locations.delete', 'COMPANY'::"PermissionScope"`)
        expect(sql).toContain(`FROM "RoleGrant" g WHERE g."permission" = 'locations.archive'`)
        expect(sql).toContain(`ON CONFLICT ("roleId", "permission") DO NOTHING`)
        expect(sql).toContain(`UPDATE "Role" SET "version" = "version" + 1, "updatedAt" = now() WHERE "id" IN (SELECT "roleId" FROM given)`)
        expect(sql).toContain(`jsonb_build_object('permission', 'locations.delete', 'scope', 'COMPANY')`)
        expect(sql).toContain(`WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t."grants"::jsonb) e WHERE e->>'permission' = 'locations.archive')`)
        expect(sql).toContain(`AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t."grants"::jsonb) e WHERE e->>'permission' = 'locations.delete')`)
    })
})

describe("the route", () => {
    const route = read("app/api/locations/route.ts")

    it("deletes the one named, for whoever may delete locations", () => {
        const del = route.slice(route.indexOf("export const DELETE"))
        expect(del).toContain('const id = new URL(req.url).searchParams.get("id")')
        expect(del).toContain('if (!id) return ApiResponse.badRequest("ID required")')
        expect(del).toContain("await LocationService.delete(session, id)")
        expect(del).toContain('{ permission: "locations.delete" }')
    })

    it("has its refusal said, as a conflict", () => {
        expect(KNOWN_REFUSALS.TASK_LOCATION_IN_USE).toEqual({ status: 409, message: "A task uses this location now, so it can't be deleted. It can be archived instead." })
    })
})

describe("the list", () => {
    const list = read("components/locations/LocationsList.tsx")

    it("offers Delete for whoever may delete locations, with or without Archive", () => {
        expect(list).toContain("const canDelete = can('locations.delete')")
        expect(list).toContain("locationActions(l, { edit: canEdit, archive: canArchive, delete: canDelete })")
        expect(list).toContain("const changes = canEdit || canArchive || canDelete")
    })

    it("has Delete in the danger colour, asking first", () => {
        expect(list).toContain("delete: { key: 'delete', label: t('locations_delete'), icon: TrashIcon, danger: true, onSelect: () => setToDelete(l) }")
        const dialog = list.slice(list.indexOf("open={!!toDelete}"))
        expect(dialog).toMatch(/^open=\{!!toDelete\}\s+title=\{t\('locations_delete'\)\}\s+body=\{t\('locations_delete_question'\)\.replace\('\{name\}', toDelete \? locationLabel\(toDelete\.name, toDelete\.client\?\.name\) : ''\)\}\s+confirmLabel=\{t\('locations_delete'\)\}\s+danger\s+onConfirm=\{confirmDelete\}/)
    })

    it("deletes the one asked, says so, and reads the list again", () => {
        expect(list).toContain("fetch(`/api/locations?id=${encodeURIComponent(l.id)}`, { method: 'DELETE' })")
        expect(list).toContain("showToast(t('locations_deleted'), 'success')")
    })

    it("says in the page's language why one a task took meanwhile is kept, and reads the list again so it's offered no more", () => {
        expect(list).toContain("answer?.code === 'TASK_LOCATION_IN_USE' ? t('locations_delete_in_use') : answer?.error || t('error_generic')")
        expect(list).toMatch(/if \(!res\.ok\) \{\s+showToast\(answer\?\.code === 'TASK_LOCATION_IN_USE'[^\n]+\n\s+if \(answer\?\.code === 'TASK_LOCATION_IN_USE'\) changed\(\)\n\s+return/)
    })

    it("closes the question once another company is picked, as the others are", () => {
        expect(list).toContain("useAdjustOnChange([scope], () => { setEditing(null); setToArchive(null); setToDelete(null); onAddingChange?.(false) })")
    })
})

describe("the words", () => {
    it("are in both languages, the Arabic gender-neutral", () => {
        expect(en.locations_delete).toBe("Delete")
        expect(en.locations_delete_question).toBe("Delete {name}? No task has used it. This can't be undone.")
        expect(en.locations_deleted).toBe("Location deleted")
        expect(en.locations_delete_in_use).toBe(KNOWN_REFUSALS.TASK_LOCATION_IN_USE.message)
        expect(ar.locations_delete).toBe("حذف")
        expect(ar.locations_delete_question).toBe("حذف {name}؟ لم تستخدمه أي مهمة، ولا يمكن التراجع عن الحذف.")
        expect(ar.locations_deleted).toBe("تم حذف الموقع")
        expect(ar.locations_delete_in_use).toBe("تستخدم مهمة هذا الموقع الآن، لذا لا يمكن حذفه. يمكن أرشفته بدلًا من ذلك.")
    })

    it("name the permission, and Archive and restore locations as it was, and the audit log's line", () => {
        expect(en.perm_locations_delete).toBe("Delete locations")
        expect(ar.perm_locations_delete).toBe("حذف المواقع")
        expect(en.perm_locations_archive).toBe("Archive and restore locations")
        expect(ar.perm_locations_archive).toBe("أرشفة المواقع واستعادتها")
        expect(AUDIT_ACTIONS).toContain("DELETE_LOCATION")
        expect(en.audit_action_DELETE_LOCATION).toBe("Deleted location")
        expect(ar.audit_action_DELETE_LOCATION).toBe("تم حذف موقع")
    })
})
