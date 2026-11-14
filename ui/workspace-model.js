/** Pure workspace logic. Snapshots contain acknowledged inspector values, never executable code. */
export function inspectorKey(model) {
  return JSON.stringify([model.view?.projectKey || 'legacy', model.view?.scope,
    [...model.params.values()].map(p => [p.id, p.source, p.kind, p.control])]);
}
export function capture(model, name) {
  if (!model.params.size) throw new Error('Open an inspector first.');
  if ([...model.params.values()].some(p => p.status === 'pending' || p.status === 'error'))
    throw new Error('Wait for every value to be acknowledged; resolve errors before saving.');
  return { id: crypto.randomUUID(), name: name.trim().slice(0, 80) || 'Untitled', at: new Date().toISOString(),
    key: inspectorKey(model), scope: model.view.scope,
    params: [...model.params.values()].map(p => ({ id: p.id, label: p.label, source: p.source, kind: p.kind,
      value: p.value, original: p.original, unit: p.unit || '' })) };
}
export function planRestore(model, preset) {
  if (preset.key !== inspectorKey(model)) throw new Error('This preset belongs to a different project, scope, or source mapping. Rediscover and save a new preset.');
  if (preset.params.length !== model.params.size) throw new Error('Preset parameter set is incomplete.');
  const seen = new Set();
  return preset.params.map(saved => {
    const p = model.params.get(saved.id), v = saved.value;
    if (!p || seen.has(saved.id)) throw new Error('Preset contains an unknown or duplicate parameter.');
    seen.add(saved.id);
    if ((p.kind === 'number' && (!Number.isFinite(v) || (p.integer && !Number.isInteger(v)) || (p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))) ||
      (p.kind === 'boolean' && typeof v !== 'boolean') ||
      (['string', 'color'].includes(p.kind) && (typeof v !== 'string' || v.length > 400)) ||
      (p.kind === 'color' && !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(v)) ||
      (p.options && !p.options.includes(v))) throw new Error(`Preset value for ${p.label} no longer fits its control.`);
    return { id: p.id, value: v };
  });
}
export function previewURL(input) {
  if (!input?.trim()) return '';
  const u = new URL(input);
  if (u.username || u.password || u.hash || u.search) throw new Error('Use an app URL without credentials, query strings, or fragments.');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
    throw new Error('Use HTTPS or a loopback HTTP dev-server URL.');
  return u.href;
}
export function handoff(model, evaluation, lesson, limits) {
  const p = capture(model, 'handoff');
  return `Let’s Tweak / ${p.scope}\nThe local Tweak agent has already written these acknowledged values to the working tree (not Git):\n` +
    p.params.filter(p => p.value !== p.original).map(p => `- ${p.label} [${p.source}]: ${JSON.stringify(p.original)} → ${JSON.stringify(p.value)}${p.unit}`).join('\n') +
    (p.params.every(p => p.value === p.original) ? '\nNo values changed from the inspector baseline.' : '') +
    `\n\nHuman evaluation: ${evaluation || 'Not recorded.'}\nDecision / reason: ${lesson || 'Not recorded.'}\nRuntime limitations: ${limits || 'Unknown; verify reload, initialization, and captured values.'}\n\nReview the actual diff and preserve unrelated changes. Confirm that the running app consumed these values; source acknowledgement alone does not prove runtime behavior. Explain anything requiring a refresh or a new instance. Do not commit unless asked.`;
}
export const ideas = [
  ['UI animation', 'animation timing and easing', 'Does the transition feel responsive and readable?'],
  ['Visual design', 'spacing, colors and typography', 'Which layout feels clear with real content?'],
  ['Data visualization', 'chart presentation', 'Can people see the pattern without hiding meaningful detail?'],
  ['Educational demo', 'learning-demo parameters', 'Can a learner explain the relationship after changing a control?'],
  ['Simulation', 'simulation model parameters', 'Which behavior changes, and is it explained by the model?'],
];
