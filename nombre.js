// Splits a wholesale title like "Corona berry 24 cm Ref: T298 (UND)" into name, reference and
// sales unit. Browser copy of catalogos-app/src/nombre.js (same rules as the PDF and the theme).
(function () {
  const MEASURES = new Set(['', 'cm', 'cms', 'mm', 'm', 'mt', 'mts', 'ml', 'l', 'lt', 'lts', 'litros', 'litro', 'g', 'gr', 'grs', 'gramos', 'kg', 'oz', 'w', 'v', 'mah', 'gb', 'x', 'und', 'unid', 'pzs', 'pcs', 'in', 'pulg', 'hz', 'k', 'p', 'cc']);
  const MARKERS = ['Ref:', 'ref:', 'REF:', 'Ref.', 'ref.', 'Ref ', 'REF ', 'ref '];
  const UNIT_LABELS = { DC: 'x docena', PAQ: 'x paquete', CJ: 'x caja' };
  const isDigit = (c) => c >= '0' && c <= '9';

  function partirNombre(title) {
    let name = String(title || '').trim();
    let reference = '';
    let unit = '';

    const unitMatch = name.match(/\(([^()]{1,4})\)\s*$/);
    if (unitMatch && unitMatch[1].trim()) {
      unit = unitMatch[1].trim().toUpperCase();
      name = name.slice(0, unitMatch.index).trim();
    }

    for (const marker of MARKERS) {
      const at = name.indexOf(marker);
      if (at > 0) {
        reference = name.slice(at + marker.length).trim();
        name = name.slice(0, at).trim();
        break;
      }
      if (at === 0) break;
    }

    if (!reference) {
      const words = name.split(' ');
      for (let offset = 1; offset <= 3; offset++) {
        const idx = words.length - offset;
        if (idx < 1) break;
        const word = words[idx];
        const lower = word.toLowerCase();
        const withoutDigits = lower.replace(/[0-9]/g, '');
        const digitCount = lower.length - withoutDigits.length;
        const letters = withoutDigits.replace(/[.,/-]/g, '');
        const startsWithDigit = isDigit(lower[0]);

        let isCode = false;
        if (digitCount >= 2 && !/[*×:]/.test(word)) {
          if (startsWithDigit) {
            if (!letters) {
              if (word.includes('-') && word.length >= 5) isCode = true;
              else if (offset === 1 && digitCount === word.length && (word.length >= 4 || (lower[0] === '0' && word.length >= 3))) isCode = true;
            } else if (letters[0] !== 'x' && !MEASURES.has(letters) && word.length >= 4) {
              isCode = true;
            }
          } else if (lower[0] === 'x') {
            // "x750": a quantity
          } else if (letters.length > 1 && letters.endsWith('x')) {
            // "CA27x20": a dimension
          } else if (word.length >= 4) {
            isCode = true;
          }
        }

        if (isCode) {
          const previous = words[idx - 1] || '';
          if (previous.toLowerCase() === 'x') break;
          reference = word;
          let refStart = idx;
          if (digitCount === word.length && idx - 1 >= 1 && previous === previous.toUpperCase() && previous.length >= 2 && previous.length <= 3 && !/[0-9]/.test(previous)) {
            reference = `${previous} ${word}`;
            refStart = idx - 1;
          }
          if (reference.slice(0, 3).toLowerCase() === 'ref' && reference.length > 3) {
            reference = reference.slice(3).replace(/^[:.]/, '').trim();
          }
          name = [...words.slice(0, refStart), ...words.slice(idx + 1)].join(' ').trim();
          break;
        }

        const isMeasure = MEASURES.has(lower) || (startsWithDigit && (!letters || letters[0] === 'x' || MEASURES.has(letters))) || (lower[0] === 'x' && isDigit(lower[1]));
        if (!isMeasure) break;
      }
    }

    return { name, reference, unit, unitLabel: UNIT_LABELS[unit] || '' };
  }

  window.partirNombre = partirNombre;
})();
