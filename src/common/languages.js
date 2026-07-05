// Language list shared by the popup and options pages.
// Codes are ISO 639-1 (what Google/DeepL/Azure and the AI prompts expect).

export const LANGUAGES = [
  ['ar', 'Arabic'],
  ['bg', 'Bulgarian'],
  ['bn', 'Bengali'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fa', 'Persian'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hu', 'Hungarian'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['ms', 'Malay'],
  ['nl', 'Dutch'],
  ['no', 'Norwegian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['sk', 'Slovak'],
  ['sv', 'Swedish'],
  ['th', 'Thai'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['vi', 'Vietnamese'],
  ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)']
];

export function languageName(code) {
  const found = LANGUAGES.find(([c]) => c === code);
  return found ? found[1] : code;
}

export function fillLanguageSelect(selectEl, selected) {
  selectEl.innerHTML = '';
  for (const [code, name] of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    if (code === selected) opt.selected = true;
    selectEl.appendChild(opt);
  }
}
