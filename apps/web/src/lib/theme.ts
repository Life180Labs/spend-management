export type Theme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'spm_theme';

// Runs inline in <head> (see app/layout.tsx) before first paint, so a saved
// day-mode choice doesn't flash the dark theme on load. Night is the default.
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem('${THEME_STORAGE_KEY}')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;
