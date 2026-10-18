// Witness media: everything Witness draws or hears, with no dependencies beyond Node.
//
//   PNG       encodePNG, decodePNG, isPNG
//   drawing   Raster (Canvas-like RGBA rasterizer with an embedded 8x16 bitmap font), parseColor
//   charts    lineChart, renderChart                         (witness trace)
//   audio     analyzePCM, formatPCMReport, decodePCM, concatPCM, wavToPCM, pcmToWav, detectOnsets,
//             plus Lumen's analysis core (analyzeEvent, analyzeMusic, analyzeMix, ...)  (witness listen)
//   pictures  timelinePNG, soundSheetPNG                     (witness listen)
//   diff      diffImages                                     (witness shot --diff)

export { encodePNG, decodePNG, isPNG } from "./png.js";
export { Raster, parseColor, withAlpha, mixColor } from "./raster.js";
export { CHARSET, hasGlyph } from "./font.js";
export { lineChart, renderChart, COLORS as CHART_COLORS } from "./chart.js";
export {
  analyzePCM, formatPCMReport, decodePCM, concatPCM, wavToPCM, pcmToWav, detectOnsets,
  analyzeEvent, describeEvent, analyzeMusic, analyzeMix, transcribe, formatReport,
  estimateTempo, estimateKey, matchChord, chromagram, notesInSpectrum, spectrogram,
  loudnessCurve, integratedLoudness, envelope, yinTrack, describePitch, mono,
  noteName, hzToMidi, midiToHz, NOTE_NAMES,
} from "./audio-analysis.js";
export { timelinePNG, soundSheetPNG } from "./spectrogram.js";
export { diffImages } from "./diff.js";
