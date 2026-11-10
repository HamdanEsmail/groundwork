export function parseDemoAddresses(markdown) {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex(line => /^\s*\|\s*#\s*\|\s*Address\s*\|/i.test(line));
  if (header < 0 || !/^\s*\|[\s:|\-]+\|\s*$/.test(lines[header + 1] ?? "")) throw new Error("Demo address table not found");
  const result = [];
  for (const line of lines.slice(header + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const cells = line.split("|").slice(1).map(cell => cell.trim());
    if (!/^\d+$/.test(cells[0] ?? "")) break;
    const match = /^(.*?)\s*\(OPA\s+(\d{9})\)\s*$/i.exec(cells[1] ?? "");
    const address = (match ? match[1] : cells[1])?.trim();
    if (!address) throw new Error("Invalid demo address");
    result.push({ address, opa: match?.[2] ?? null });
  }
  if (result.length !== 3 || new Set(result.map(row => row.address.toUpperCase())).size !== 3) throw new Error("Expected three distinct demo addresses");
  return result;
}

export function hasMonitorCapacity(watches, addressCount) {
  return Number.isSafeInteger(watches) && watches >= 0 && Number.isSafeInteger(addressCount) && addressCount >= 0 && watches + addressCount * 2 <= 10;
}
