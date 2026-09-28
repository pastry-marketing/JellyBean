import { SERVICE_CATEGORIES } from "@/data/service-options";

export type ServiceSelection = {
  service_name: string;
  service_category: string | null;
};

export type RoutingAssignment = {
  service_key: string;
  assigned_cs_user_id: string;
};

export type LeadRoutingInput = {
  assigned_to?: string | null;
  service?: string | null;
  state_code?: string | null;
};

export function normalizeLeadService(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

export function findServiceCategory(serviceName: string): string | null {
  const target = normalizeLeadService(serviceName);
  if (!target) return null;

  for (const group of SERVICE_CATEGORIES) {
    if (group.services.some((service) => normalizeLeadService(service) === target)) {
      return group.category;
    }
  }

  return null;
}

export function toServiceSelection(
  serviceName: string,
  serviceCategory?: string | null,
): ServiceSelection {
  const trimmed = serviceName.trim();
  return {
    service_name: trimmed,
    service_category: serviceCategory ?? findServiceCategory(trimmed),
  };
}

export function mergeServiceSelections(
  current: ServiceSelection[],
  incoming: ServiceSelection,
): ServiceSelection[] {
  const incomingKey = normalizeLeadService(incoming.service_name);
  if (!incomingKey) return current;

  const withoutDuplicate = current.filter(
    (item) => normalizeLeadService(item.service_name) !== incomingKey,
  );
  return [...withoutDuplicate, incoming];
}

export function resolveServiceAssignmentOwner(
  service: string | null | undefined,
  assignments: RoutingAssignment[],
): string | null {
  const serviceKey = normalizeLeadService(service);
  if (!serviceKey) return null;
  return (
    assignments.find((assignment) => assignment.service_key === serviceKey)?.assigned_cs_user_id ??
    null
  );
}

export function resolveQualifiedLeadOwner({
  lead,
  serviceAssignments,
  stateAssignments,
}: {
  lead: LeadRoutingInput;
  serviceAssignments: RoutingAssignment[];
  stateAssignments: Record<string, string>;
}): string | null {
  if (lead.assigned_to) return lead.assigned_to;

  const serviceOwner = resolveServiceAssignmentOwner(lead.service, serviceAssignments);
  if (serviceOwner) return serviceOwner;

  return lead.state_code ? (stateAssignments[lead.state_code] ?? null) : null;
}
