// A closed palette. Saved notes carry only the preset ID, never arbitrary CSS.
const swatch=(id,name,background,accent,mode='dark')=>Object.freeze({id,name,background,accent,mode,ink:mode==='dark'?'#F5F0E9':'#252D36',secondary:mode==='dark'?'#D5D0CA':'#424E58',muted:mode==='dark'?'#BDB6AE':'#53606B'});
export const NOTE_THEMES=Object.freeze([
  swatch('coal','Carvão','#1B1D24','#BCC6E4'),
  swatch('petrol','Petróleo','#102B32','#83D5DB'),
  swatch('navy','Marinho','#162844','#96C6FA'),
  swatch('indigo','Índigo','#28234A','#BCB0FF'),
  swatch('plum','Ameixa','#382443','#E3AFE8'),
  swatch('wine','Vinho','#40212E','#F0A9BF'),
  swatch('brick','Terracota','#432923','#F0B19C'),
  swatch('cocoa','Cacau','#352B25','#DDBE9D'),
  swatch('olive','Oliva','#2B321E','#C5D98B'),
  swatch('forest','Floresta','#17382E','#92D9B8'),
  swatch('butter','Manteiga','#F5E9BB','#6C4D08','light'),
  swatch('peach','Pêssego','#F6DDC9','#7C4424','light'),
  swatch('rose','Rosa','#F4D7E3','#8C3559','light'),
  swatch('lilac','Lilás','#E8DEF5','#614080','light'),
  swatch('sky','Céu','#D8E8F7','#24547C','light'),
  swatch('mint','Menta','#D8EEE5','#235E49','light'),
  swatch('pistachio','Pistache','#E6EDC9','#4D601B','light'),
  swatch('sand','Linho','#EDE3D1','#685034','light'),
  swatch('ice','Gelo','#DDECEE','#2A5D66','light'),
  swatch('porcelain','Porcelana','#F1ECE7','#615246','light'),
]);
export const resolveNoteTheme=id=>NOTE_THEMES.find(theme=>theme.id===id) || null;
export function noteThemeVariables(id){
  const theme=resolveNoteTheme(id);if(!theme)return {};
  const dark=theme.mode==='dark';
  return {
    '--note-bg':theme.background,'--glass-strong':theme.background,'--ink':theme.ink,'--ink-2':theme.secondary,'--ink-3':theme.muted,
    '--line':dark?'rgba(245,240,233,.16)':'rgba(37,45,54,.18)','--line-strong':dark?'rgba(245,240,233,.28)':'rgba(37,45,54,.3)',
    '--field':dark?'rgba(255,255,255,.055)':'rgba(255,255,255,.4)','--foot':dark?'rgba(0,0,0,.12)':'rgba(255,255,255,.22)',
    '--hover':dark?'rgba(255,255,255,.07)':'rgba(37,45,54,.06)','--hover-2':dark?'rgba(255,255,255,.12)':'rgba(37,45,54,.10)',
    '--accent':theme.accent,'--acc-ink':theme.accent,'--on-accent':theme.background,
    '--acc-soft':dark?'rgba(255,255,255,.10)':'rgba(37,45,54,.08)','--acc-soft-2':dark?'rgba(255,255,255,.18)':'rgba(37,45,54,.14)','--acc-line':theme.accent,
    '--sel':dark?'rgba(255,255,255,.12)':'rgba(37,45,54,.10)',
  };
}
