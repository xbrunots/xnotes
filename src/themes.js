// Presets only replace material colors. Accent, blur and motion remain independent.
const dark = ({ wall, lights, surface, side, list, glass, muted = '#A2A2AE' }) => ({
  '--wall': wall,
  '--b1': lights[0], '--b2': lights[1], '--b3': lights[2], '--b4': lights[3],
  '--win': surface, '--side': side, '--list': list, '--glass-strong': glass,
  '--field': 'rgba(255,255,255,.045)', '--foot': 'rgba(255,255,255,.025)',
  '--line': 'rgba(255,255,255,.09)', '--line-strong': 'rgba(255,255,255,.15)',
  '--ink': '#F5F4F8', '--ink-2': '#C3C2CE', '--ink-3': muted,
  '--hover': 'rgba(255,255,255,.055)', '--hover-2': 'rgba(255,255,255,.10)',
  '--sel': 'rgba(255,255,255,.085)', '--scrim': 'rgba(0,0,0,.60)',
  '--shadow': '0 32px 100px -24px rgba(0,0,0,.85), 0 8px 28px -12px rgba(0,0,0,.65)',
  '--pane-shadow': '0 16px 42px -20px rgba(0,0,0,.65)',
});

const light = ({ wall, lights, surface, side, list, glass, ink, secondary, muted, shadow }) => ({
  '--wall': wall,
  '--b1': lights[0], '--b2': lights[1], '--b3': lights[2], '--b4': lights[3],
  '--win': surface, '--side': side, '--list': list, '--glass-strong': glass,
  '--field': 'rgba(255,255,255,.65)', '--foot': 'rgba(255,255,255,.36)',
  '--line': 'rgba(30,24,60,.11)', '--line-strong': 'rgba(30,24,60,.18)',
  '--ink': ink, '--ink-2': secondary, '--ink-3': muted,
  '--hover': 'rgba(30,24,60,.05)', '--hover-2': 'rgba(30,24,60,.09)',
  '--sel': 'rgba(30,24,60,.075)', '--scrim': 'rgba(30,27,42,.24)',
  '--shadow': `0 32px 90px -28px ${shadow}, 0 8px 24px -12px ${shadow}`,
  '--pane-shadow': `0 12px 36px -18px ${shadow}`,
});

const preset = (id, name, mode, description, variables) => Object.freeze({
  id, name, mode, description, variables: Object.freeze(variables),
});

export const DEFAULT_THEME_ID = 'obsidian';
export const DEFAULT_LIGHT_THEME_ID = 'snow';

export const THEMES = Object.freeze([
  preset('obsidian', 'Obsidiana', 'dark', 'Preto quase absoluto, com luz mínima.', dark({
    wall: '#020203', lights: ['#040405', '#050506', '#030405', '#050405'],
    surface: 'rgba(4,4,5,.94)', side: 'rgba(7,7,8,.92)',
    list: 'rgba(9,9,11,.90)', glass: 'rgba(15,15,18,.98)',
  })),
  preset('carbon', 'Carbono', 'dark', 'Grafite profundo, neutro e discreto.', dark({
    wall: '#08090B', lights: ['#0C0D10', '#0F1014', '#0A0E10', '#0F0D11'],
    surface: 'rgba(10,11,14,.89)', side: 'rgba(14,15,18,.85)',
    list: 'rgba(17,18,22,.84)', glass: 'rgba(23,24,29,.97)',
  })),
  preset('midnight', 'Meia-noite', 'dark', 'Azul noturno em superfícies bem escuras.', dark({
    wall: '#050914', lights: ['#0B1425', '#111933', '#091C28', '#181326'],
    surface: 'rgba(8,13,24,.86)', side: 'rgba(12,18,32,.82)',
    list: 'rgba(15,22,37,.80)', glass: 'rgba(19,28,45,.97)',
    muted: '#A5ADBE',
  })),
  preset('forest', 'Bosque', 'dark', 'Verde fechado, com um brilho sutil.', dark({
    wall: '#060C0B', lights: ['#101A13', '#101A20', '#0D231C', '#1A1713'],
    surface: 'rgba(9,16,14,.86)', side: 'rgba(13,22,19,.82)',
    list: 'rgba(16,26,23,.80)', glass: 'rgba(21,33,29,.97)',
    muted: '#A5B4AE',
  })),
  preset('amethyst', 'Ametista', 'dark', 'Violeta escuro com o vidro da referência.', dark({
    wall: '#0B0712', lights: ['#261A1A', '#241A3F', '#132629', '#2C1528'],
    surface: 'rgba(16,11,23,.84)', side: 'rgba(23,17,32,.78)',
    list: 'rgba(26,20,36,.76)', glass: 'rgba(32,25,44,.97)',
    muted: '#B3A9C2',
  })),
  preset('snow', 'Neve', 'light', 'Branco suave e superfícies frescas.', light({
    wall: '#EDF0F5', lights: ['#F5F2EA', '#E4EAF8', '#E3F2ED', '#F0E8F0'],
    surface: 'rgba(255,255,255,.54)', side: 'rgba(249,250,253,.66)',
    list: 'rgba(255,255,255,.56)', glass: 'rgba(255,255,255,.97)',
    ink: '#1B202A', secondary: '#454D5D', muted: '#626B7B', shadow: 'rgba(45,60,91,.24)',
  })),
  preset('paper', 'Papel', 'light', 'Off-white neutro para escrever por horas.', light({
    wall: '#F1EFE8', lights: ['#F2E8D8', '#E9E6DF', '#E6ECE2', '#F0E5E2'],
    surface: 'rgba(255,253,247,.56)', side: 'rgba(250,248,240,.66)',
    list: 'rgba(255,254,249,.56)', glass: 'rgba(255,253,247,.97)',
    ink: '#282722', secondary: '#555247', muted: '#6C675C', shadow: 'rgba(78,65,40,.22)',
  })),
  preset('sand', 'Areia', 'light', 'Tons quentes de linho e areia clara.', light({
    wall: '#EEE4D8', lights: ['#F4DEBE', '#E5DAD9', '#E2E7D9', '#EED8D2'],
    surface: 'rgba(255,249,238,.60)', side: 'rgba(250,241,227,.72)',
    list: 'rgba(255,250,241,.62)', glass: 'rgba(255,249,239,.98)',
    ink: '#30271E', secondary: '#5C4C3D', muted: '#74604E', shadow: 'rgba(97,64,28,.23)',
  })),
  preset('mist', 'Bruma', 'light', 'Cinza azulado, leve e sereno.', light({
    wall: '#E3EBEE', lights: ['#E8ECE7', '#D7E5F0', '#D9EBE7', '#E8E3EB'],
    surface: 'rgba(245,251,253,.60)', side: 'rgba(236,245,249,.70)',
    list: 'rgba(247,252,254,.60)', glass: 'rgba(247,252,254,.98)',
    ink: '#1B2C35', secondary: '#435A66', muted: '#596D78', shadow: 'rgba(36,71,90,.23)',
  })),
  preset('lavender', 'Lavanda', 'light', 'Lilás delicado e luz difusa.', light({
    wall: '#EBE5F2', lights: ['#F4E4DC', '#DCD5F4', '#DCECE8', '#F1DDEB'],
    surface: 'rgba(253,249,255,.60)', side: 'rgba(246,240,252,.70)',
    list: 'rgba(253,250,255,.60)', glass: 'rgba(253,250,255,.98)',
    ink: '#292235', secondary: '#574C69', muted: '#71627E', shadow: 'rgba(77,46,108,.24)',
  })),
]);

/** An explicit preset wins; legacy dark/light is used only for absent or unknown IDs. */
export function resolveTheme(presetId, legacyMode = 'dark') {
  return THEMES.find(theme => theme.id === presetId)
    || THEMES.find(theme => theme.id === (legacyMode === 'light' ? DEFAULT_LIGHT_THEME_ID : DEFAULT_THEME_ID));
}

/** Returns a fresh object so consumers can merge accent/blur without changing the catalog. */
export function themeVariables(themeOrId) {
  const theme = typeof themeOrId === 'object' && themeOrId ? themeOrId : resolveTheme(themeOrId);
  return { ...(theme.variables || resolveTheme().variables) };
}
