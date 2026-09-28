import { MapContainer, TileLayer, Marker, Popup, Circle, useMapEvents } from "react-leaflet";
import L from "leaflet";

const DefaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

export type PlacedAccount = {
  id: string;
  name: string;
  area: string | null;
  latitude: number;
  longitude: number;
  last_launched_at: string | null;
  launched_today: boolean;
  today_launch_count: number;
  notes: string | null;
  is_active: boolean;
};

interface Props {
  placed: PlacedAccount[];
  visuals: boolean;
  radiusMode: "daily" | "all" | "inactive" | "inactive_daily";
  tempPin?: { lat: number; lng: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
}

const FIFTY_MILES_IN_METERS = 80467;

function ClickToPlace({ onPlace }: { onPlace: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

export default function LeafletMap({ placed, visuals, radiusMode, tempPin, onMapClick }: Props) {
  const items: React.ReactNode[] = [];

  for (const account of placed) {
    if (radiusMode === "daily" && !account.launched_today) continue;
    if (radiusMode === "inactive" && account.is_active) continue;
    if (radiusMode === "inactive_daily" && (account.is_active || !account.launched_today)) continue;

    const showCircle = visuals;

    if (showCircle) {
      items.push(
        <Circle
          key={`c-${account.id}`}
          center={[account.latitude, account.longitude]}
          radius={FIFTY_MILES_IN_METERS}
          pathOptions={{
            color: account.launched_today ? "#14b8a6" : "#94a3b8",
            fillColor: account.launched_today ? "#14b8a6" : "#94a3b8",
            fillOpacity: 0.14,
            weight: 2,
          }}
        >
          <Popup>
            <CoveragePopup account={account} />
          </Popup>
        </Circle>,
      );
    }

    items.push(
      <Marker key={`m-${account.id}`} position={[account.latitude, account.longitude]}>
        <Popup>
          <CoveragePopup account={account} />
        </Popup>
      </Marker>,
    );
  }

  return (
    <MapContainer
      center={[39.5, -98.35]}
      zoom={4}
      minZoom={3}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {onMapClick && <ClickToPlace onPlace={onMapClick} />}
      {tempPin && (
        <>
          <Circle
            center={[tempPin.lat, tempPin.lng]}
            radius={FIFTY_MILES_IN_METERS}
            pathOptions={{
              color: "#ef4444",
              fillColor: "#ef4444",
              fillOpacity: 0.18,
              weight: 2,
            }}
          />
          <Marker position={[tempPin.lat, tempPin.lng]}>
            <Popup>
              <div className="text-[12px]">
                <div className="font-semibold">Temporary 50-mile radius</div>
                <div className="text-muted-foreground mt-1">Clears when you leave this page.</div>
              </div>
            </Popup>
          </Marker>
        </>
      )}
      {items}
    </MapContainer>
  );
}

function CoveragePopup({ account }: { account: PlacedAccount }) {
  return (
    <div className="text-[12.5px] min-w-[170px]">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Account name</div>
      <div className="font-semibold">{account.name}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-2">
        Account area
      </div>
      <div>{account.area ?? "-"}</div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-muted-foreground">Today</div>
          <div className="font-medium">{account.launched_today ? "Covered" : "Missing"}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Launch count</div>
          <div className="font-medium tabular-nums">{account.today_launch_count}</div>
        </div>
      </div>
      <div className="mt-2 text-[11px]">
        <div className="text-muted-foreground mb-0.5">Note</div>
        <div className="font-medium whitespace-pre-wrap">
          {account.notes || (
            <span className="text-muted-foreground italic font-normal">No note added</span>
          )}
        </div>
      </div>
      {account.last_launched_at && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Last launch: {new Date(account.last_launched_at).toLocaleString()}
        </div>
      )}
    </div>
  );
}
