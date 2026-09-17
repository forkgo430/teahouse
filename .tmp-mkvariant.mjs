import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('.tmp', { recursive: true });
const html = readFileSync('茶馆.html', 'utf8');
const mk = (n, inj) => { writeFileSync(`.tmp/${n}`, html.replace('</html>', inj + '\n</html>'), 'utf8'); };

const PLAY = `
<script>
window.addEventListener('load', () => {
  setTimeout(() => { const it=[...document.querySelectorAll('.boot-item')].find(i=>i.textContent.includes('体验模式')); if(it) it.click(); }, 500);
  setTimeout(() => { const h=document.querySelector('.shelf-handle'); if(h) h.click(); }, 2400);
});
</script>`;

const PROBE = `
<script>
const L=[];
window.addEventListener('error', e => L.push('ERR: '+e.message));
window.addEventListener('load', () => {
  setTimeout(() => { const it=[...document.querySelectorAll('.boot-item')].find(i=>i.textContent.includes('体验模式')); if(it) it.click(); }, 500);
  setTimeout(() => {
    try {
      const h = document.querySelector('.shelf-handle');
      L.push('handle=' + !!h);
      if (h) h.click();
      setTimeout(() => {
        try {
          const d = document.querySelector('.ne-drawer-right');
          L.push('drawer=' + !!d);
          L.push('left=' + Math.round(d.getBoundingClientRect().left) + ' w=' + Math.round(d.getBoundingClientRect().width));
          L.push('inline=' + (d.style.translate || '(空)'));
          L.push('computed=' + getComputedStyle(d).translate);
          L.push('innerW=' + innerWidth);
        } catch (e) { L.push('inner ERR: ' + e.message); }
        const out=document.createElement('pre'); out.id='P'; out.textContent=L.join('\\n');
        document.body.appendChild(out);
      }, 700);
    } catch (e) { L.push('ERR2: ' + e.message); }
  }, 2600);
});
</script>`;

mk('mobile.html', PLAY);
mk('probe.html', PROBE);
console.log('变体已按新产物生成');
