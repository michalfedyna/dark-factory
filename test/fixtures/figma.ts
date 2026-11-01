import type { FigmaResult, FigmaSource } from '../../src/contracts/figma.js';

export const figmaSource: FigmaSource = {
  url: 'https://www.figma.com/design/DesignKey?node-id=1%3A2',
  fileKey: 'DesignKey',
  nodeId: '1:2',
  version: null,
};

export const figmaResult: FigmaResult = {
  summary: 'Scaffolded the export panel.',
  components: ['src/ui/Export.tsx: onExport callback.'],
  designSystem: ['src/ui/tokens.css'],
  implementationNotes: ['Wire the export callback and replace sample content.'],
  limitations: [],
  blockers: [],
};
