/**
 * Lead details in the shape returned by the Graph lead endpoint.
 * https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
 * This process never calls Facebook. The map below stands in for that lookup.
 */
export type GraphField = {
  name: string;
  values: string[];
};

export type GraphLead = {
  created_time: string;
  id: string;
  ad_id?: string;
  form_id: string;
  field_data: GraphField[];
};

export type Registration = {
  lead: GraphLead;
  formName: string;
  pageId: string;
  adId: string;
  createdUnix: number;
};

export type GraphFetch = {
  id: string;
  at: string;
  failed: boolean;
};

export type GraphStandIn = {
  put(entry: Registration): void;
  failNext(id: string): void;
  failAlways(id: string): void;
  get(id: string): Registration | undefined;
  fetchLead(id: string): Promise<{ lead: GraphLead; formName: string }>;
  fetches(): GraphFetch[];
};

export function createGraphStandIn(): GraphStandIn {
  const leads = new Map<string, Registration>();
  const once = new Set<string>();
  const always = new Set<string>();
  const log: GraphFetch[] = [];

  return {
    put(entry) {
      leads.set(entry.lead.id, entry);
    },
    failNext(id) {
      once.add(id);
    },
    failAlways(id) {
      always.add(id);
    },
    get(id) {
      return leads.get(id);
    },
    async fetchLead(id) {
      const at = new Date().toISOString();
      if (always.has(id) || once.delete(id)) {
        log.push({ id, at, failed: true });
        throw new Error("lead lookup unavailable");
      }
      const found = leads.get(id);
      if (!found) {
        log.push({ id, at, failed: true });
        throw new Error("lead lookup missed");
      }
      log.push({ id, at, failed: false });
      return { lead: structuredClone(found.lead), formName: found.formName };
    },
    fetches() {
      return log.map((row) => ({ ...row }));
    },
  };
}
