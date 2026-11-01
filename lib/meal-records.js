const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Store instants in UTC; use one explicit calendar (Asia/Seoul) for daily views.
const koreanDay = date => new Date(new Date(date).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

function mealWindow(now = new Date()) {
  const today = koreanDay(now);
  const startOfToday = new Date(`${today}T00:00:00+09:00`);
  const start = new Date(startOfToday.getTime() - 6 * DAY_MS);
  const end = new Date(startOfToday.getTime() + DAY_MS);
  const labels = Array.from({ length: 7 }, (_, i) => koreanDay(new Date(start.getTime() + i * DAY_MS)));
  return { today, start, end, labels };
}

function summarizeMeals(records, window) {
  const totals = new Map(window.labels.map(day => [day, 0]));
  const kcalByMeal = Object.create(null);
  for (const record of records) {
    const instant = new Date(record.date);
    if (!(instant >= window.start && instant < window.end)) continue;
    const day = koreanDay(instant);
    const kcal = Number(record.totalKcal);
    if (!Number.isFinite(kcal) || kcal < 0) continue;
    totals.set(day, totals.get(day) + kcal);
    if (day === window.today) kcalByMeal[record.mealType] = (kcalByMeal[record.mealType] || 0) + kcal;
  }
  return { kcalByMeal, mealChart: { labels: window.labels, values: [...totals.values()] } };
}

function parseMealItems(raw) {
  const items = JSON.parse(raw);
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Invalid meal items');
  return items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string') {
      throw new Error('Invalid meal item');
    }
    // Preserve the existing storage limit for long names returned by the food API.
    const name = item.name.trim().slice(0, 50);
    const kcal = item.kcal;
    const weight = item.weight;
    if (!name || typeof kcal !== 'number' || !Number.isFinite(kcal) || kcal < 0 || kcal > 100000 ||
        typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100000) {
      throw new Error('Invalid meal item');
    }
    return { name, kcal, weight };
  });
}

module.exports = { mealWindow, summarizeMeals, parseMealItems };
