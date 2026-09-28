import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeServiceSelections,
  normalizeLeadService,
  resolveQualifiedLeadOwner,
  resolveServiceAssignmentOwner,
  toServiceSelection,
} from "./service-assignment";

describe("service assignment helpers", () => {
  it("normalizes service names by trimming, lowercasing, and collapsing spaces", () => {
    expect(normalizeLeadService("Garage Door Repair")).toBe("garage door repair");
    expect(normalizeLeadService(" garage door repair ")).toBe("garage door repair");
    expect(normalizeLeadService("GARAGE   DOOR   REPAIR")).toBe("garage door repair");
    expect(normalizeLeadService("   ")).toBeNull();
    expect(normalizeLeadService(null)).toBeNull();
  });

  it("keeps different exact normalized services separate", () => {
    const assignments = [{ service_key: "garage door repair", assigned_cs_user_id: "cs-b" }];

    expect(resolveServiceAssignmentOwner("Garage Door Repair", assignments)).toBe("cs-b");
    expect(resolveServiceAssignmentOwner("GARAGE   DOOR   REPAIR", assignments)).toBe("cs-b");
    expect(resolveServiceAssignmentOwner("Garage Floor Repair", assignments)).toBeNull();
    expect(resolveServiceAssignmentOwner("Garage Repair", assignments)).toBeNull();
    expect(resolveServiceAssignmentOwner("Garage Door Installation", assignments)).toBeNull();
  });

  it("prevents two selected services with the same normalized key", () => {
    const first = toServiceSelection("Garage Door Repair", "Garage Services");
    const second = toServiceSelection(" GARAGE   DOOR   REPAIR ", "Garage Services");
    const selected = mergeServiceSelections(mergeServiceSelections([], first), second);

    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual({
      service_name: "GARAGE   DOOR   REPAIR",
      service_category: "Garage Services",
    });
  });

  it("allows custom services without silently changing their display value", () => {
    expect(toServiceSelection("Custom Basement Pump Fix")).toEqual({
      service_name: "Custom Basement Pump Fix",
      service_category: null,
    });
  });

  it("resolves routing precedence as explicit owner, service, then state", () => {
    const serviceAssignments = [{ service_key: "garage door repair", assigned_cs_user_id: "cs-b" }];
    const stateAssignments = { TX: "cs-a" };

    expect(
      resolveQualifiedLeadOwner({
        lead: { assigned_to: "explicit-cs", service: "Garage Door Repair", state_code: "TX" },
        serviceAssignments,
        stateAssignments,
      }),
    ).toBe("explicit-cs");
    expect(
      resolveQualifiedLeadOwner({
        lead: { assigned_to: null, service: "GARAGE   DOOR   REPAIR", state_code: "TX" },
        serviceAssignments,
        stateAssignments,
      }),
    ).toBe("cs-b");
    expect(
      resolveQualifiedLeadOwner({
        lead: { assigned_to: null, service: "Roof Repair", state_code: "TX" },
        serviceAssignments,
        stateAssignments,
      }),
    ).toBe("cs-a");
    expect(
      resolveQualifiedLeadOwner({
        lead: { assigned_to: null, service: "Unknown Service", state_code: null },
        serviceAssignments,
        stateAssignments,
      }),
    ).toBeNull();
  });

  it("wires the Lead Assignment route to admin and CS admin with the Service Assignment tab", () => {
    const route = readFileSync("src/routes/app.lead-assignment.tsx", "utf8");

    expect(route).toContain('allow={["admin", "cs_admin"]}');
    expect(route).toContain('<TabsTrigger value="assignments">State Assignments</TabsTrigger>');
    expect(route).toContain(
      '<TabsTrigger value="service-assignment">Service Assignment</TabsTrigger>',
    );
    expect(route).toContain('<TabsTrigger value="analytics">Analytics</TabsTrigger>');
  });

  it("keeps service routing in the existing qualified lead trigger path", () => {
    const migration = readFileSync(
      "supabase/migrations/20260722090000_add_service_assignments.sql",
      "utf8",
    );

    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.tg_qualified_leads_route_by_state()",
    );
    expect(migration).not.toMatch(/CREATE\s+TRIGGER\s+qualified_leads_route_by_service/i);
    expect(migration.indexOf("IF NEW.assigned_to IS NOT NULL")).toBeLessThan(
      migration.indexOf("FROM public.service_assignments"),
    );
    expect(migration.indexOf("FROM public.service_assignments")).toBeLessThan(
      migration.indexOf("FROM public.state_assignments"),
    );
  });
});
