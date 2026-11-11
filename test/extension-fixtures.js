// Provider manifests used as declarations only. Copied from the provider packages' extension.json files
// (devkits-asana, devkits-system, devkits-simulator); mod names follow the herdr-zed-* convention.
export const asanaManifest = `{
  "version": 1,
  "id": "asana",
  "title": "Asana",
  "actions": [
    {
      "id": "open",
      "title": "Asana",
      "icon": "asana",
      "iconColor": "#F06A6A",
      "popup": {
        "view": "browser",
        "width": 0.9,
        "height": 0.86,
        "modal": false
      },
      "location": "status.right"
    }
  ]
}
`;

export const systemManifest = `{
  "version": 1,
  "id": "system",
  "title": "System Monitor",
  "services": [
    { "view": "service" }
  ],
  "surfaces": [
    { "id": "widgets", "location": "sidebar.bottom", "view": "widgets", "title": "System widgets", "icon": "chart-column" },
    { "id": "inline", "location": "status.right", "view": "inline", "title": "System metrics", "icon": "chart-column" }
  ],
  "actions": [
    {
      "id": "open",
      "title": "SYSTEM",
      "icon": "chart-column",
      "popup": {
        "view": "details",
        "width": 1000,
        "height": 700,
        "modal": false
      },
      "location": "status.right"
    }
  ]
}
`;

export const simulatorManifest = `{
  "version": 1,
  "id": "simulator",
  "title": "iOS Simulator",
  "dependencies": ["herdr-zed-sim-frames"],
  "actions": [
    {
      "id": "open",
      "title": "iOS Simulator",
      "icon": "smartphone",
      "popup": {
        "view": "simulator-popup",
        "width": 480,
        "height": 760,
        "modal": false
      },
      "location": "status.right"
    }
  ],
  "surfaces": [{ "id": "simulator", "location": "dock.right", "view": "simulator", "title": "iOS Simulator", "icon": "smartphone" }]
}
`;
