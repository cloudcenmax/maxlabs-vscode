export const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const inline = (value) => {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return output;
};

const cells = (line) => {
  const protectedPipes = [];
  const protectedLine = line.trim().replace(/\\\|/g, () => `\u0001${protectedPipes.push("|") - 1}\u0001`).replace(/^\||\|$/g, "");
  return protectedLine.split("|").map((cell) => cell.trim().replace(/\u0001(\d+)\u0001/g, (_, index) => protectedPipes[Number(index)]));
};

function tableAt(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes("|") || !lines[index + 1].includes("|")) return undefined;
  let headers = cells(lines[index]);
  const dividers = cells(lines[index + 1]);
  if (!headers.length || dividers.length < 2 || !dividers.every((cell) => /^:?-{3,}:?$/.test(cell))) return undefined;
  if (headers.length !== dividers.length) {
    const firstRow = lines[index + 2] || "";
    if (!firstRow.includes("|") || cells(firstRow).length < 2 || headers.length > dividers.length) return undefined;
    const heading = headers.length === 1 ? headers[0].match(/^#{1,3}\s+(.+)$/) : undefined;
    headers = heading && dividers.length === 2 ? ["Item", heading[1]] : [...headers, ...Array(dividers.length - headers.length).fill("")];
  }
  const aligns = dividers.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : "");
  const cellTag = (tag, value, column) => `<${tag}${aligns[column] ? ` style="text-align:${aligns[column]}"` : ""}>${inline(value || "")}</${tag}>`;
  let html = `<div class="table-scroll"><table><thead><tr>${headers.map((value, column) => cellTag("th", value, column)).join("")}</tr></thead><tbody>`;
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].trim() && lines[cursor].includes("|")) {
    const row = cells(lines[cursor]);
    html += `<tr>${headers.map((_, column) => cellTag("td", row[column], column)).join("")}</tr>`;
    cursor++;
  }
  return { html: `${html}</tbody></table></div>`, next: cursor };
}

export function markdown(source) {
  const blocks = [];
  const tokenized = source.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_, language, code) => {
    const token = `\u0000${blocks.length}\u0000`;
    blocks.push(`<pre data-language="${escapeHtml(language.trim())}"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return token;
  });
  const lines = tokenized.split("\n");
  const result = [];
  let list = null;
  const closeList = () => { if (list) { result.push(`</${list}>`); list = null; } };
  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const table = tableAt(lines, index);
    if (table) { closeList(); result.push(table.html); index = table.next; continue; }
    const token = line.match(/^\u0000(\d+)\u0000$/);
    if (token) { closeList(); result.push(blocks[Number(token[1])]); index++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { closeList(); const level = heading[1].length; result.push(`<h${level}>${inline(heading[2])}</h${level}>`); index++; continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) { const kind = unordered ? "ul" : "ol"; if (list !== kind) { closeList(); result.push(`<${kind}>`); list = kind; } result.push(`<li>${inline((unordered || ordered)[1])}</li>`); index++; continue; }
    closeList();
    if (!line.trim()) { result.push(""); index++; continue; }
    if (/^---+$/.test(line.trim())) { result.push("<hr>"); index++; continue; }
    if (line.startsWith("> ")) { result.push(`<blockquote>${inline(line.slice(2))}</blockquote>`); index++; continue; }
    result.push(`<p>${inline(line)}</p>`); index++;
  }
  closeList();
  return result.join("").replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}
