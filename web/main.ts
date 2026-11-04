/** Page bootstrap: read the view mode from the page, then hand over to the UI shell. */
import { bootView, MODES } from '../src/ui/index.js';
import type { ViewMode } from '../src/core/index.js';

const fromPage = document.documentElement.dataset.mode;
const fromQuery = new URLSearchParams(window.location.search).get('mode');
const pick = (fromQuery ?? fromPage ?? 'wallpaper') as ViewMode;
bootView(MODES.includes(pick) ? pick : 'wallpaper', document.body);
