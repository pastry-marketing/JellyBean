import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_SERVICE_OPTIONS,
  SERVICE_CATEGORIES,
  filterServiceCategories,
  getServiceCategoryCount,
  getServiceOptionCount,
  isExistingService,
  normalizeServiceSearch,
} from "./service-options";

function servicesFor(categoryName: string, query: string) {
  return (
    filterServiceCategories(query).find((group) => group.category === categoryName)?.services ?? []
  );
}

describe("service options", () => {
  it("loads every category and service from the configured list", () => {
    expect(getServiceCategoryCount()).toBe(39);
    expect(getServiceOptionCount()).toBe(2063);
    expect(SERVICE_CATEGORIES[0]?.category).toBe("Plumbing");
    expect(ALL_SERVICE_OPTIONS).toContain("Garage Door Repair");
  });

  it("shows all services in a matching category", () => {
    const garageServices = servicesFor("Garage Services", "garage");

    expect(garageServices).toEqual([
      "Garage Repair",
      "Garage Remodeling",
      "Garage Door Repair",
      "Garage Door Installation",
      "Garage Door Replacement",
      "Garage Door Opener Repair",
      "Garage Door Opener Installation",
      "Garage Door Spring Replacement",
      "Garage Door Cable Repair",
      "Garage Door Track Repair",
      "Garage Door Panel Replacement",
      "Garage Door Weatherstripping",
      "Garage Door Insulation",
      "Garage Floor Repair",
      "Garage Floor Epoxy",
      "Garage Shelving Installation",
      "Garage Storage Installation",
      "Garage Cabinet Installation",
      "Garage Lighting Installation",
      "Garage Ventilation Installation",
      "Garage Door Maintenance",
      "Garage Door Tune-Up",
      "Garage Door Sensor Repair",
      "Garage Door Sensor Replacement",
      "Garage Door Roller Replacement",
      "Garage Door Belt Replacement",
      "Garage Door Chain Replacement",
      "Garage Door Drum Repair",
      "Garage Door Torsion Spring Replacement",
      "Garage Door Extension Spring Replacement",
      "Garage Door Alignment",
      "Garage Door Keypad Installation",
      "Garage Door Keypad Repair",
      "Garage Door Remote Programming",
      "Garage Door Remote Repair",
      "Garage Door Bottom Seal Replacement",
      "Garage Door Side Seal Replacement",
      "Garage Door Top Seal Replacement",
      "Garage Door Threshold Installation",
      "Garage Door Conversion",
      "Commercial Garage Door Repair",
      "Commercial Garage Door Installation",
      "Roll-Up Door Repair",
      "Roll-Up Door Installation",
      "Garage Floor Polyaspartic Coating",
      "Garage Floor Refinishing",
      "Garage Floor Resurfacing",
      "Garage Floor Leveling",
    ]);
  });

  it("finds garage services located outside the Garage Services category", () => {
    const filtered = filterServiceCategories("garage");
    const matchingServices = filtered.flatMap((group) => group.services);

    expect(matchingServices).toContain("Garage Floor Coating");
    expect(matchingServices).toContain("Garage Insulation");
    expect(matchingServices).toContain("Garage Cleaning");
    expect(matchingServices).toContain("Garage Conversion");
    expect(matchingServices).toContain("Smart Garage Door Opener Installation");
  });

  it("finds individual services by partial words and keeps category grouping", () => {
    const filtered = filterServiceCategories("water heater");

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.some((group) => group.category === "Plumbing")).toBe(true);
    expect(servicesFor("Plumbing", "water heater")).toEqual(
      expect.arrayContaining([
        "Water Heater Repair",
        "Water Heater Installation",
        "Water Heater Replacement",
        "Tankless Water Heater Repair",
        "Tankless Water Heater Installation",
      ]),
    );
  });

  it("searches case-insensitively and trims the query", () => {
    expect(servicesFor("Garage Services", "  GARAGE  ")).toContain("Garage Door Repair");
    expect(normalizeServiceSearch("  RePair  ")).toBe("repair");
  });

  it("detects existing services without blocking custom values", () => {
    expect(isExistingService("Garage Door Repair")).toBe(true);
    expect(isExistingService("garage door repair")).toBe(true);
    expect(isExistingService("Custom entered service")).toBe(false);
    expect(isExistingService("   ")).toBe(false);
  });

  it("keeps every global lead form render routed through the shared LeadForm", () => {
    const submitLead = readFileSync("src/routes/app.submit-lead.tsx", "utf8");
    const rawLeads = readFileSync("src/routes/app.raw-leads.tsx", "utf8");
    const forwardedLeads = readFileSync("src/routes/app.forwarded-leads.tsx", "utf8");
    const leadForm = readFileSync("src/components/lead-form.tsx", "utf8");

    expect(submitLead).toContain("<LeadForm");
    expect(rawLeads).toContain("<LeadForm");
    expect(forwardedLeads).toContain("<LeadForm");
    expect(leadForm).toContain("<ServiceCombobox");
    expect(leadForm).not.toContain('placeholder="Service"');
  });
});
