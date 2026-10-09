import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader, PageBody, RoleGate } from "@/components/page";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import type { PlacedAccount } from "@/components/leaflet-map";
import { pktDayKey, pktTodayKey } from "@/lib/timezone";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/map")({
  head: () => ({ meta: [
    { title: "Coverage Map \u00b7 JellyBean" },
    { name: "description", content: "Review account coverage and browser profile activity." },
    { property: "og:title", content: "Coverage Map \u00b7 JellyBean" },
    { property: "og:description", content: "Review account coverage and browser profile activity." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }), component: Page });

type LaunchHistoryEntry = { at: string; by?: string | null };

type BrowserProfile = {
  id: string;
  profile_name: string;
  account_area: string | null;
  latitude: number | null;
  longitude: number | null;
  last_launched_at: string | null;
  launch_history: Json;
  notes: string | null;
  is_active: boolean;
};

type LeafletMapComp = ComponentType<{
  placed: PlacedAccount[];
  visuals: boolean;
  radiusMode: MapRadiusMode;
  tempPin?: { lat: number; lng: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
}>;

type MapRadiusMode = "daily" | "all" | "inactive" | "inactive_daily";

function Page() {
  const auth = useAuth();
  return (
    <div>
      <PageHeader
        title="Map"
        description="Daily 50-mile launch coverage from browser profile coordinates."
      />
      <PageBody>
        <RoleGate allow={["admin", "sub_admin", "acc_handler"]} current={auth.primaryRole}>
          <Inner />
        </RoleGate>
      </PageBody>
    </div>
  );
}

function Inner() {
  const [visuals, setVisuals] = useState(true);
  const [radiusMode, setRadiusMode] = useState<MapRadiusMode>("daily");
  const [LeafletMap, setLeafletMap] = useState<LeafletMapComp | null>(null);
  const [tempPin, setTempPin] = useState<{ lat: number; lng: number } | null>(null);
  const coverageScrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const visualsValue = localStorage.getItem("map.visuals");
    const modeValue = localStorage.getItem("map.radiusMode");
    if (visualsValue === "1") setVisuals(true);
    if (modeValue === "all" || modeValue === "daily") setRadiusMode(modeValue);
    import("@/components/leaflet-map").then((module) => setLeafletMap(() => module.default));
  }, []);

  const toggle = (next: boolean) => {
    setVisuals(next);
    localStorage.setItem("map.visuals", next ? "1" : "0");
  };

  const changeRadiusMode = (next: string) => {
    const mode = next as MapRadiusMode;
    setRadiusMode(mode);
    localStorage.setItem("map.radiusMode", mode);
  };

  const profiles = useQuery({
    queryKey: ["incog-profiles-map"],
    queryFn: async () => {
      // Page past PostgREST's default 1000-row ceiling so large fleets render fully.
      const all: BrowserProfile[] = [];
      const pageSize = 1000;
      for (let page = 0; page < 20; page++) {
        const from = page * pageSize;
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from("incogniton_profiles")
          .select(
            "id, profile_name, account_area, latitude, longitude, last_launched_at, launch_history, notes, is_active",
          )
          .order("last_launched_at", { ascending: false, nullsFirst: false })
          .range(from, to);
        if (error) throw error;
        const rows = (data ?? []) as BrowserProfile[];
        all.push(...rows);
        if (rows.length < pageSize) break;
      }
      return all;
    },
  });

  const todayKey = useMemo(() => pktTodayKey(), []);

  const placed = useMemo<PlacedAccount[]>(() => {
    return (profiles.data ?? [])
      .filter(
        (profile): profile is BrowserProfile & { latitude: number; longitude: number } =>
          profile.latitude !== null && profile.longitude !== null,
      )
      .map((profile) => {
        const history = parseHistory(profile.launch_history);
        const todayLaunchCount = countLaunchesOnDay(history, todayKey, profile.last_launched_at);
        return {
          id: profile.id,
          name: profile.profile_name,
          area: profile.account_area,
          latitude: profile.latitude,
          longitude: profile.longitude,
          last_launched_at: profile.last_launched_at,
          launched_today: todayLaunchCount > 0,
          today_launch_count: todayLaunchCount,
          notes: profile.notes,
          is_active: profile.is_active,
        };
      });
  }, [profiles.data, todayKey]);

  const coverage = useMemo(() => {
    const byArea = new Map<string, { total: number; covered: number; launches: number }>();
    for (const profile of placed) {
      const key = profile.area?.trim() || "Unassigned";
      const current = byArea.get(key) ?? { total: 0, covered: 0, launches: 0 };
      current.total += 1;
      current.launches += profile.today_launch_count;
      if (profile.launched_today) current.covered += 1;
      byArea.set(key, current);
    }
    return Array.from(byArea.entries()).sort(
      (a, b) => b[1].covered - a[1].covered || b[1].total - a[1].total,
    );
  }, [placed]);

  const coveredToday = placed.filter((profile) => profile.launched_today).length;
  const missingToday = placed.length - coveredToday;
  const fullRadiusCount = radiusMode === "all" ? placed.length : coveredToday;
  const scrollCoverage = (direction: -1 | 1) => {
    const node = coverageScrollerRef.current;
    if (!node) return;
    node.scrollBy({ left: direction * Math.round(node.clientWidth * 0.78), behavior: "smooth" });
  };

  return (
    <div className="grid lg:grid-cols-5 gap-4">
      <div className="lg:col-span-3 glass-card p-5 min-w-0">
        <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between mb-4 gap-4">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">
              {radiusMode === "all" ? "Added account radius" : "Daily profile coverage"}
            </h3>
            <div className="text-[11.5px] text-muted-foreground mt-0.5">
              {radiusMode === "all"
                ? "Every added browser profile with coordinates shows a 50-mile radius."
                : "Shows a 50-mile radius for profiles launched today. The daily window resets at midnight PKT."}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Tabs
              value={radiusMode}
              onValueChange={changeRadiusMode}
              className="max-w-full overflow-x-auto pb-1 -mb-1"
            >
              <TabsList className="h-9 w-max flex-shrink-0">
                <TabsTrigger value="daily" className="h-7 text-[11.5px]">
                  Today
                </TabsTrigger>
                <TabsTrigger value="all" className="h-7 text-[11.5px]">
                  All profiles
                </TabsTrigger>
                <TabsTrigger value="inactive" className="h-7 text-[11.5px]">
                  Inactive profiles
                </TabsTrigger>
                <TabsTrigger value="inactive_daily" className="h-7 text-[11.5px]">
                  Inactive today
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground whitespace-nowrap">
                <span className="inline-flex items-center gap-1.5 shrink-0">
                  <span className="h-2 w-2 rounded-full bg-primary" />
                  Covered today
                </span>
                <span className="inline-flex items-center gap-1.5 shrink-0">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground/60" />
                  Missing today
                </span>
              </div>
              <div className="flex items-center gap-2 pl-3 border-l border-border shrink-0">
                <Label
                  htmlFor="visuals"
                  className="text-[12px] text-muted-foreground cursor-pointer whitespace-nowrap"
                >
                  Map visuals
                </Label>
                <Switch id="visuals" checked={visuals} onCheckedChange={toggle} />
              </div>
            </div>
          </div>
        </div>

        {!visuals ? (
          <div className="aspect-[16/10] w-full rounded-lg border border-dashed border-border bg-surface/40 grid place-items-center text-center px-6">
            <div>
              <div className="text-sm font-medium">Map visuals are off</div>
              <div className="text-[12px] text-muted-foreground mt-1">
                Toggle "Map visuals" on to load map tiles and coverage circles.
              </div>
            </div>
          </div>
        ) : profiles.isLoading || !LeafletMap ? (
          <div className="h-[480px] grid place-items-center text-muted-foreground">Loading...</div>
        ) : (
          <div className="aspect-[16/10] w-full rounded-lg overflow-hidden border border-border bg-surface">
            <LeafletMap
              placed={placed}
              visuals={visuals}
              radiusMode={radiusMode}
              tempPin={tempPin}
              onMapClick={(lat, lng) => setTempPin({ lat, lng })}
            />
          </div>
        )}
        <p className="text-[11.5px] text-muted-foreground mt-3">
          {visuals
            ? "Click anywhere on the map to drop a temporary 50-mile red radius. It clears when you leave this page."
            : "Turn map visuals on to inspect coverage circles and profile locations."}
          {tempPin && (
            <>
              {" · "}
              <button
                type="button"
                onClick={() => setTempPin(null)}
                className="underline text-destructive hover:text-destructive/80"
              >
                Clear temporary radius
              </button>
            </>
          )}
          {" · "}
          {fullRadiusCount} full 50-mile radii · {coveredToday} covered today · {missingToday}{" "}
          missing · {placed.length} pinned profiles
        </p>
      </div>

      <div className="lg:col-span-2 glass-card p-5 min-w-0">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Coverage by area</h3>
            <p className="text-[11.5px] text-muted-foreground mt-0.5">
              Swipe or use arrows to move through areas.
            </p>
          </div>
          {coverage.length > 0 && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => scrollCoverage(-1)}
                className="h-8 w-8 grid place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Scroll coverage areas left"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => scrollCoverage(1)}
                className="h-8 w-8 grid place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Scroll coverage areas right"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-5">
          <Stat label="Covered" value={coveredToday} />
          <Stat label="Missing" value={missingToday} />
        </div>
        {coverage.length === 0 ? (
          <div className="text-sm text-muted-foreground">No pinned profiles.</div>
        ) : (
          <div
            ref={coverageScrollerRef}
            className="-mx-1 flex gap-3 overflow-x-auto scroll-smooth px-1 pb-2 [scrollbar-width:thin] snap-x snap-mandatory"
          >
            {coverage.map(([area, counts]) => {
              const covered = counts.covered > 0;
              const percent =
                counts.total > 0 ? Math.round((counts.covered / counts.total) * 100) : 0;
              return (
                <div
                  key={area}
                  className="min-w-[210px] max-w-[210px] snap-start rounded-2xl border border-border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className="truncate text-[13px] font-semibold text-foreground"
                        title={area}
                      >
                        {area}
                      </div>
                      <div className="mt-1 text-[11.5px] text-muted-foreground">
                        {counts.covered}/{counts.total} profiles covered
                      </div>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                        covered ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {percent}%
                    </span>
                  </div>
                  <div className="mt-4 h-2 rounded-full bg-surface overflow-hidden">
                    <div
                      className={cn(
                        "h-full transition-all duration-500",
                        covered ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-between text-[11.5px] text-muted-foreground">
                    <span>
                      {counts.launches} {counts.launches === 1 ? "launch" : "launches"}
                    </span>
                    <span>{counts.total - counts.covered} missing</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function parseHistory(value: Json): LaunchHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is LaunchHistoryEntry => {
    return (
      !!entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.at === "string"
    );
  });
}

function countLaunchesOnDay(
  history: LaunchHistoryEntry[],
  targetDay: string,
  lastLaunchedAt: string | null,
) {
  const historyCount = history.filter((entry) => pktDayKey(entry.at) === targetDay).length;
  if (historyCount > 0) return historyCount;
  if (!lastLaunchedAt) return 0;
  return pktDayKey(lastLaunchedAt) === targetDay ? 1 : 0;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border bg-surface/60 p-3">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </div>
  );
}
