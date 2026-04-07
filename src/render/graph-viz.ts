import type { KnowledgeStore } from "../graph/store.js";

export function renderGraphData(store: KnowledgeStore): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceGroups: Record<string, string[]>;
} {
  const pages = store.listPages();
  const claims = store.listClaims();

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Build claim count lookup for importance scoring
  const claimCountByPage = new Map<string, number>();
  for (const claim of claims) {
    claimCountByPage.set(
      claim.pageId,
      (claimCountByPage.get(claim.pageId) || 0) + 1,
    );
  }

  // Page nodes
  for (const page of pages) {
    const count = claimCountByPage.get(page.id) || 0;
    const pageClaims = claims.filter((c) => c.pageId === page.id);
    const avgConf = pageClaims.length
      ? pageClaims.reduce((s, c) => s + c.confidence, 0) / pageClaims.length
      : 0;
    nodes.push({
      id: page.id,
      label: page.title,
      type: "page",
      size: count <= 1 ? 8 : Math.min(40, 8 + Math.log2(count) * 8),
      color: confidenceColor(avgConf),
      metadata: { claims: count, avgConfidence: avgConf },
    });
  }

  // Page links (explicit) — ALL edges, with importance score for LOD rendering
  const edgeSet = new Set<string>();
  for (const page of pages) {
    for (const targetId of page.linksTo) {
      const key = `${page.id}→${targetId}`;
      const keyRev = `${targetId}→${page.id}`;
      if (!edgeSet.has(key) && !edgeSet.has(keyRev)) {
        edgeSet.add(key);
        // Importance = sum of claim counts at both endpoints (hub-to-hub links matter most)
        const imp =
          (claimCountByPage.get(page.id) || 0) +
          (claimCountByPage.get(targetId) || 0);
        edges.push({
          source: page.id,
          target: targetId,
          type: "link",
          weight: 1,
          importance: imp,
        });
      }
    }
  }

  // Shared-source groups: send mapping for on-demand rendering instead of O(n²) edges
  const sourceToPages = new Map<string, Set<string>>();
  for (const claim of claims) {
    for (const srcId of claim.sources) {
      if (!sourceToPages.has(srcId)) sourceToPages.set(srcId, new Set());
      sourceToPages.get(srcId)!.add(claim.pageId);
    }
  }
  const sourceGroups: Record<string, string[]> = {};
  for (const [srcId, pageIds] of sourceToPages.entries()) {
    if (pageIds.size >= 2) {
      sourceGroups[srcId] = [...pageIds];
    }
  }

  // Claim contradiction edges (always important — keep all)
  for (const claim of claims) {
    for (const cid of claim.contradictedBy) {
      const other = claims.find((c) => c.id === cid);
      if (other && claim.pageId !== other.pageId) {
        const key = `${claim.pageId}→${other.pageId}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({
            source: claim.pageId,
            target: other.pageId,
            type: "contradiction",
            weight: 2,
            importance: 999, // contradictions always visible
          });
        }
      }
    }
  }

  // Sort by importance descending so renderer can slice by LOD
  edges.sort((a, b) => (b.importance || 0) - (a.importance || 0));

  return { nodes, edges, sourceGroups };
}

export function renderGraphHTML(store: KnowledgeStore): string {
  const { nodes, edges } = renderGraphData(store);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Quicky Wiki — Knowledge Graph</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; background: #1a1a2e; color: #eee; font-family: system-ui; }
    svg { width: 100vw; height: 100vh; }
    .node text { font-size: 11px; fill: #ccc; }
    .link { stroke-opacity: 0.4; }
    .contradiction { stroke: #ff4444; stroke-dasharray: 4; }
  </style>
</head>
<body>
  <svg></svg>
  <script>
    const nodes = ${JSON.stringify(nodes)};
    const links = ${JSON.stringify(edges.map((e) => ({ source: e.source, target: e.target, type: e.type })))};

    const svg = d3.select("svg");
    const width = window.innerWidth, height = window.innerHeight;

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2));

    const link = svg.selectAll(".link")
      .data(links).enter().append("line")
      .attr("class", d => "link " + (d.type === "contradiction" ? "contradiction" : ""))
      .attr("stroke", d => d.type === "contradiction" ? "#ff4444" : "#555")
      .attr("stroke-width", 1.5);

    const node = svg.selectAll(".node")
      .data(nodes).enter().append("g").attr("class", "node")
      .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));

    node.append("circle")
      .attr("r", d => d.size / 2)
      .attr("fill", d => d.color);

    node.append("text")
      .attr("dx", d => d.size / 2 + 4)
      .attr("dy", 4)
      .text(d => d.label);

    simulation.on("tick", () => {
      link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
          .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      node.attr("transform", d => "translate(" + d.x + "," + d.y + ")");
    });

    function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
    function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
    function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }
  </script>
</body>
</html>`;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return "#a78bfa"; /* soft lavender */
  if (confidence >= 0.5) return "#fbbf24"; /* warm amber */
  return "#f87171"; /* soft rose */
}

interface GraphNode {
  id: string;
  label: string;
  type: "page" | "claim";
  size: number;
  color: string;
  metadata: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  type: "link" | "dependency" | "contradiction" | "shared-source";
  weight: number;
  importance?: number;
}
