import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PRESETS, CATEGORIES } from '../src/renderer/presets/builtin.js';
import { PresetStore } from '../src/renderer/presets/PresetStore.js';
import { memoryStorage } from '../src/renderer/presets/storage.js';
import { isNeutral, normalizeSettings, pitchStageActive } from '../src/renderer/vocal/settings.js';

const EXPECTED = {
  essentials: ['Studio', 'Flow', 'Chorale', 'Tandem', 'Automate', 'Mirage'],
  hiphop: ['Brut', 'Granit', 'Velours', 'Carré', 'Méduse'],
  hyperpop: ['Surshift', 'Survolt', 'Pixel', 'Néon'],
  scifi: ['Astra'],
  signature: ['Tiers', 'Puce', 'Marée', 'Combiné', 'Ampli', 'Prisme', 'Auréole', 'Bourdon'],
};

test('les 24 presets demandés, dans les bonnes catégories et dans l’ordre', () => {
  assert.deepEqual(
    CATEGORIES.map((c) => c.name),
    ['Les Indispensables', 'Hip Hop', 'Hyperpop', 'Sci-Fi', 'Collection Signature'],
  );
  for (const [cat, names] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      BUILTIN_PRESETS.filter((p) => p.category === cat).map((p) => p.name),
      names,
    );
  }
  assert.equal(BUILTIN_PRESETS.length, 24);
  assert.equal(new Set(BUILTIN_PRESETS.map((p) => p.id)).size, 24);
});

test('chaque preset est valide (aucune valeur hors bornes corrigée) et non neutre', () => {
  for (const p of BUILTIN_PRESETS) {
    const n = normalizeSettings(p.settings);
    assert.ok(!isNeutral(n), `${p.name} ne fait rien`);
    assert.ok(p.description.length > 10, `${p.name} : description`);
    // Les valeurs écrites doivent survivre telles quelles à la validation.
    for (const section of ['pitch', 'voice', 'vocoder', 'drone']) {
      for (const [k, v] of Object.entries(p.settings[section] ?? {})) {
        assert.equal(n[section][k], v, `${p.name}.${section}.${k} = ${v} modifié en ${n[section][k]}`);
      }
    }
    (p.settings.chain ?? []).forEach((m, i) => {
      assert.equal(n.chain[i].type, m.type, `${p.name} : module ${m.type} perdu`);
      for (const [k, v] of Object.entries(m.params)) assert.equal(n.chain[i].params[k], v, `${p.name}.${m.type}.${k}`);
    });
    for (const [i, v] of (p.settings.harmony?.voices ?? []).entries()) {
      for (const [k, val] of Object.entries(v)) assert.equal(n.harmony.voices[i][k], val, `${p.name} voix ${i}.${k}`);
    }
  }
});

test('intentions sonores clés', () => {
  const get = (id) => normalizeSettings(BUILTIN_PRESETS.find((p) => p.id === id).settings);
  assert.equal(get('automate').pitch.speed, 0); // robot = instantané
  assert.ok(get('brut').pitch.speed >= 120 && get('brut').pitch.strength <= 60); // naturel
  assert.equal(get('surshift').pitch.shift, 12);
  assert.ok(get('astra').vocoder.enabled);
  assert.ok(get('bourdon').drone.enabled);
  assert.equal(get('tiers').harmony.voices[0].interval, 2);
  assert.ok(get('combine').chain.some((m) => m.type === 'telephone'));
  assert.ok(get('pixel').chain.some((m) => m.type === 'bitcrush'));
  assert.ok(!pitchStageActive(get('combine'))); // pas de rendu hors temps réel inutile
});

test('PresetStore : créer, modifier, supprimer, persister', async () => {
  const storage = memoryStorage();
  const store = new PresetStore(storage);
  await store.load();
  assert.equal(store.categories.at(-1).presets.length, 0);

  const settings = normalizeSettings({ pitch: { correct: true, speed: 12 }, chain: [{ type: 'reverb' }] });
  const p = await store.create('  Ma voix  ', settings);
  assert.equal(p.name, 'Ma voix');
  assert.ok(store.isUser(p.id));
  assert.equal(storage.data.length, 1);
  assert.equal(storage.data[0].settings.chain[0].id, undefined); // pas d'identifiants internes

  const dup = await store.create('ma voix', settings);
  assert.equal(dup.name, 'ma voix 2');

  await store.update(p.id, {
    name: 'Ma voix live',
    settings: { ...settings, pitch: { ...settings.pitch, speed: 30 } },
  });
  assert.equal(store.settingsOf(p.id).pitch.speed, 30);

  // Rechargement depuis le stockage.
  const again = new PresetStore(storage);
  await again.load();
  assert.deepEqual(
    again.categories.at(-1).presets.map((x) => x.name),
    ['Ma voix live', 'ma voix 2'],
  );

  await again.remove(dup.id);
  assert.equal(storage.data.length, 1);
});

test('PresetStore : les presets fournis sont protégés, les entrées corrompues ignorées', async () => {
  const store = new PresetStore(
    memoryStorage([{ id: 'x', name: '' }, null, { id: 'ok', name: 'Bon', settings: { pitch: { speed: 999 } } }]),
  );
  await store.load();
  assert.deepEqual(
    store.user.map((p) => p.name),
    ['Bon'],
  );
  assert.equal(store.settingsOf('ok').pitch.speed, 400);
  await assert.rejects(() => store.update('studio', { name: 'Hack' }));
  await assert.rejects(() => store.remove('studio'));
  await assert.rejects(() => store.create('   ', {}));
  assert.ok(store.get('studio').builtin);
});
