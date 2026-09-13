/** Preview studies, not additions to the public overlay theme contract. */
export const treatments = [
  {
    id: "outline",
    group: "Standard",
    name: "Crisp outline",
    description: "A thin listener-colored perimeter and component label.",
    useful: "The default choice for checking render boundaries.",
    limit: "Nested components can create nested outlines.",
  },
  {
    id: "wash",
    group: "Standard",
    name: "Soft highlight",
    description:
      "A translucent color wash briefly illuminates the updated region.",
    useful: "Spotting changes while keeping the app readable.",
    limit: "Subtle fills need a perimeter on low-contrast surfaces.",
  },
  {
    id: "rail",
    group: "Standard",
    name: "Activity rail",
    description: "A narrow inset rail marks the start edge of updated content.",
    useful: "Dense lists and message feeds where full boxes feel noisy.",
    limit: "Shows location more clearly than the entire boundary.",
  },
  {
    id: "corners",
    group: "Standard",
    name: "Corner brackets",
    description:
      "Four brackets frame the rendered component without boxing in its content.",
    useful: "Reading large components with less visual obstruction.",
    limit: "Tiny components leave little space between brackets.",
  },
  {
    id: "label",
    group: "Standard",
    name: "Label only",
    description:
      "A compact component tag appears above each update; no region tint.",
    useful: "Checking which component names appear during a delivery.",
    limit: "Less effective for understanding the full affected area.",
  },
  {
    id: "radar",
    group: "Experimental",
    name: "Radar pulse",
    description: "A single expanding perimeter announces each new render.",
    useful: "Catching occasional updates in peripheral vision.",
    limit: "The pulse communicates recency, not elapsed time.",
  },
  {
    id: "scan",
    group: "Experimental",
    name: "Scanner pass",
    description:
      "A fine horizontal band travels through the updated region once.",
    useful: "Following tall message lists from top to bottom.",
    limit: "Scan direction is a visual cue, not rendering order.",
  },
  {
    id: "ants",
    group: "Experimental",
    name: "Marching perimeter",
    description:
      "A moving dashed perimeter marks an active delivery, then settles.",
    useful: "Separating fresh activity from quiet retained marks.",
    limit: "Keep movement brief; constant motion becomes distracting.",
  },
  {
    id: "echo",
    group: "Experimental",
    name: "Echo rings",
    description:
      "Three close contour rings disperse around the changed component.",
    useful: "Seeing the footprint of isolated updates without a fill.",
    limit: "Rings are emphasis, not three separate renders.",
  },
  {
    id: "heat",
    group: "Experimental",
    name: "Heat memory",
    description:
      "Regions warm from blue to amber as their observed update count rises.",
    useful: "Finding repeatedly updated components during a burst.",
    limit: "Heat means observed marks in this session, not CPU cost.",
  },
  {
    id: "stamp",
    group: "Experimental",
    name: "Delivery stamps",
    description:
      "A compact numbered receipt tags each component with its delivery and hit count.",
    useful: "Comparing which regions were marked in the same delivery.",
    limit: "A shared number means correlation, not proven causality.",
  },
  {
    id: "ruler",
    group: "Experimental",
    name: "Measurement brackets",
    description:
      "Dimension guides label the actual width and height of changed regions.",
    useful: "Finding unexpectedly large render footprints.",
    limit: "Pixel area does not measure render time or complexity.",
  },
  {
    id: "threads",
    group: "Experimental",
    name: "Thread map",
    description:
      "Curves connect the triggering control to the regions Flow actually marked.",
    useful: "Understanding one delivery followed by several component updates.",
    limit: "Links show observed association, not a traced dependency graph.",
  },
  {
    id: "trail",
    group: "Experimental",
    name: "History trail",
    description:
      "Numbered footprints connect the last five observed deliveries across the page.",
    useful:
      "Following a burst through messages, presence, typing, and receipts.",
    limit: "The trail shows temporal order, not data transfer between regions.",
  },
  {
    id: "minimap",
    group: "Experimental",
    name: "Render mini-map",
    description:
      "A small spatial map mirrors the chat and highlights its marked regions.",
    useful: "Seeing scattered updates together while inspecting a dense page.",
    limit:
      "Small regions are easier to locate on the map than to identify by name.",
  },
] as const;
export type TreatmentId = (typeof treatments)[number]["id"];
