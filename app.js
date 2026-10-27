// Catálogos PDF panel, shown inside Shopify admin (Apps → Catálogos PDF).
// Lists the catalogs (metaobjects "catalogo_pdf") and, for each one, shows its products in PDF
// order so they can be removed, put back, added or re-sorted with one click. Everything is saved
// in the same metaobject fields the generator reads (excluir_productos, incluir_productos,
// orden_productos), so the PDF picks it up on its next hourly run.
// Talks to the Admin API through App Bridge's Direct API access: no server, no keys in this code.
(function () {
  const API = 'shopify:admin/api/2026-10/graphql.json';
  const PAIS = 'CO'; // Same prices as the PDF (Colombia market, includes the +19% adjustment)
  const ORDENES_LISTA = ['Como en la colección', 'Nombre (A-Z)', 'Más nuevos primero', 'Más antiguos primero', 'Precio: menor a mayor', 'Precio: mayor a menor'];
  const ORDENES = {
    'Nombre (A-Z)': (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base', numeric: true }),
    'Más nuevos primero': (a, b) => b.creado.localeCompare(a.creado),
    'Más antiguos primero': (a, b) => a.creado.localeCompare(b.creado),
    'Precio: menor a mayor': (a, b) => a.precio - b.precio,
    'Precio: mayor a menor': (a, b) => b.precio - a.precio,
  };
  const MOTIVOS = { sinFoto: 'Sin foto', sinInventario: 'Sin inventario', inactivo: 'Borrador o no publicado' };

  const CAMPOS_PRODUCTO = `
    id title status onlineStoreUrl totalInventory createdAt
    featuredMedia { preview { image { url(transform: { maxWidth: 360 }) } } }
    contextualPricing(context: { country: ${PAIS} }) {
      minVariantPricing { price { amount } }
      maxVariantPricing { price { amount } }
    }
    variants(first: 1) { nodes { sku } }
  `;

  const app = document.getElementById('app');
  let catalogos = [];
  let actual = null; // the catalog being edited

  // ---------- Admin API ----------

  async function gql(query, variables) {
    for (let intento = 0; ; intento++) {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      const json = await res.json().catch(() => ({}));
      const throttled = (json.errors || []).some((e) => e.extensions && e.extensions.code === 'THROTTLED');
      if ((throttled || res.status >= 500) && intento < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (intento + 1)));
        continue;
      }
      if (!res.ok || json.errors) throw new Error((json.errors && json.errors[0] && json.errors[0].message) || `Error ${res.status}`);
      return json.data;
    }
  }

  async function paginar(build, pick) {
    const out = [];
    let after = null;
    for (;;) {
      const conn = pick(await gql(build(), { after }));
      if (!conn) return out;
      out.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) return out;
      after = conn.pageInfo.endCursor;
    }
  }

  async function leerPorIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { nodes } = await gql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${CAMPOS_PRODUCTO} } } }`, { ids: ids.slice(i, i + 100) });
      out.push(...nodes.filter((n) => n && n.id));
    }
    return out;
  }

  async function leerCatalogos() {
    const data = await gql(`{
      metaobjects(type: "catalogo_pdf", first: 250) {
        nodes {
          id handle
          fields {
            key value
            reference {
              ... on Collection { id title }
              ... on GenericFile { url }
              ... on MediaImage { image { url(transform: { maxWidth: 400 }) } }
            }
          }
        }
      }
    }`);
    return data.metaobjects.nodes
      .map((m) => {
        const f = Object.fromEntries(m.fields.map((x) => [x.key, x]));
        const val = (k) => (f[k] ? f[k].value : null);
        const ref = (k) => (f[k] ? f[k].reference : null);
        const lista = (k) => {
          try {
            return JSON.parse(val(k) || '[]');
          } catch (e) {
            return [];
          }
        };
        const portada = ref('portada');
        const pdf = ref('pdf');
        return {
          id: m.id,
          slug: m.handle,
          titulo: val('nombre') || m.handle,
          origen: val('origen') || 'Colección',
          coleccion: ref('coleccion'),
          valor: val('valor'),
          activo: val('activo') !== 'false',
          orden: val('orden_productos') || 'Como en la colección',
          posicion: Number(val('orden')) || 9999,
          productos: Number(val('productos')) || 0,
          actualizado: val('actualizado'),
          incluir: lista('incluir_productos'),
          excluir: lista('excluir_productos'),
          portadaUrl: portada && portada.image ? portada.image.url : null,
          pdfUrl: pdf && pdf.url ? pdf.url : null,
        };
      })
      .sort((a, b) => a.posicion - b.posicion || a.titulo.localeCompare(b.titulo, 'es'));
  }

  // Same source rules as the generator (catalogos-app/src/fuente-admin.js)
  async function leerBase(cat) {
    if (cat.origen === 'Colección') {
      if (!cat.coleccion) throw new Error('Este catálogo no tiene colección elegida. Edítalo y elige una.');
      return paginar(
        () => `query($after: String) { collection(id: "${cat.coleccion.id}") { products(first: 100, after: $after) { nodes { ${CAMPOS_PRODUCTO} } pageInfo { hasNextPage endCursor } } } }`,
        (d) => d.collection && d.collection.products
      );
    }
    const filtro = { Etiqueta: 'tag', 'Tipo de producto': 'product_type', Marca: 'vendor' }[cat.origen];
    if (!filtro || !cat.valor) throw new Error('Este catálogo no tiene etiqueta, tipo o marca. Edítalo y complétalo.');
    const q = `status:active ${filtro}:'${String(cat.valor).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return paginar(
      () => `query($after: String) { products(first: 100, after: $after, query: ${JSON.stringify(q)}, sortKey: CREATED_AT, reverse: true) { nodes { ${CAMPOS_PRODUCTO} } pageInfo { hasNextPage endCursor } } }`,
      (d) => d.products
    );
  }

  function aProducto(p) {
    const min = Number(p.contextualPricing.minVariantPricing.price.amount);
    const max = Number(p.contextualPricing.maxVariantPricing.price.amount);
    const imagen = p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image ? p.featuredMedia.preview.image.url : null;
    let estado = 'ok';
    if (p.status !== 'ACTIVE' || !p.onlineStoreUrl) estado = 'inactivo';
    else if (!imagen) estado = 'sinFoto';
    else if (!(p.totalInventory > 0)) estado = 'sinInventario';
    return {
      id: p.id,
      title: p.title,
      ...window.partirNombre(p.title),
      sku: (p.variants.nodes[0] || {}).sku || '',
      imagen,
      precio: Math.round(min),
      precioVariable: Math.round(max) !== Math.round(min),
      creado: p.createdAt || '',
      inventario: p.totalInventory,
      estado,
    };
  }

  // ---------- Saving ----------

  let cola = Promise.resolve();
  function guardar(campos, mensaje, deshacer) {
    const id = actual.id;
    const fields = Object.entries(campos).map(([key, value]) => ({ key, value }));
    cola = cola.then(async () => {
      try {
        const data = await gql(
          `mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { userErrors { field message } } }`,
          { id, m: { fields } }
        );
        const err = data.metaobjectUpdate.userErrors[0];
        if (err) throw new Error(err.message);
        aviso(mensaje, deshacer);
      } catch (e) {
        aviso(`No se pudo guardar: ${e.message}`, null, true);
      }
    });
    return cola;
  }

  function guardarListas(mensaje, deshacer) {
    // Keep the list on the catalog card in sync too
    const cat = catalogos.find((c) => c.id === actual.id);
    if (cat) {
      cat.incluir = [...actual.incluir];
      cat.excluir = [...actual.excluir];
    }
    return guardar({ incluir_productos: JSON.stringify(actual.incluir), excluir_productos: JSON.stringify(actual.excluir) }, mensaje, deshacer);
  }

  function aviso(mensaje, deshacer, error) {
    if (window.shopify && shopify.toast) {
      const opciones = { duration: 4000, isError: !!error };
      if (deshacer) Object.assign(opciones, { action: 'Deshacer', onAction: deshacer });
      shopify.toast.show(mensaje, opciones);
    }
  }

  // ---------- Actions ----------

  const sin = (lista, id) => lista.filter((x) => x !== id);

  function foto() {
    return { incluir: [...actual.incluir], excluir: [...actual.excluir] };
  }
  function restaurar(f, mensaje) {
    actual.incluir = f.incluir;
    actual.excluir = f.excluir;
    pintarDetalle();
    guardarListas(mensaje);
  }

  function quitar(id) {
    const antes = foto();
    const p = actual.productos.get(id);
    if (actual.base.has(id)) {
      actual.incluir = sin(actual.incluir, id);
      if (!actual.excluir.includes(id)) actual.excluir.push(id);
    } else {
      // It was only in the catalog because it was added by hand
      actual.incluir = sin(actual.incluir, id);
    }
    pintarDetalle();
    guardarListas(`Quitado: ${p ? p.name : 'producto'}`, () => restaurar(antes, 'Cambio deshecho'));
  }

  function volver(id) {
    const antes = foto();
    const p = actual.productos.get(id);
    actual.excluir = sin(actual.excluir, id);
    if (!actual.base.has(id) && !actual.incluir.includes(id)) actual.incluir.push(id);
    pintarDetalle();
    guardarListas(`Incluido de nuevo: ${p ? p.name : 'producto'}`, () => restaurar(antes, 'Cambio deshecho'));
  }

  async function agregar() {
    if (!window.shopify || !shopify.resourcePicker) return;
    const elegidos = await shopify.resourcePicker({ type: 'product', multiple: true, action: 'add', filter: { variants: false, draft: false, archived: false } });
    if (!elegidos || !elegidos.length) return;
    const antes = foto();
    const ids = elegidos.map((p) => p.id);
    for (const id of ids) {
      actual.excluir = sin(actual.excluir, id);
      if (!actual.base.has(id) && !actual.incluir.includes(id)) actual.incluir.push(id);
    }
    const faltan = ids.filter((id) => !actual.productos.has(id));
    if (faltan.length) (await leerPorIds(faltan)).map(aProducto).forEach((p) => actual.productos.set(p.id, p));
    pintarDetalle();
    guardarListas(ids.length === 1 ? 'Producto agregado' : `${ids.length} productos agregados`, () => restaurar(antes, 'Cambio deshecho'));
  }

  function cambiarOrden(orden) {
    const anterior = actual.orden;
    actual.orden = orden;
    const cat = catalogos.find((c) => c.id === actual.id);
    if (cat) cat.orden = orden;
    pintarDetalle();
    guardar({ orden_productos: orden }, `Orden: ${orden}`, () => {
      actual.orden = anterior;
      if (cat) cat.orden = anterior;
      pintarDetalle();
      guardar({ orden_productos: anterior }, 'Cambio deshecho');
    });
  }

  // ---------- Views ----------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const precioTexto = (p) => `${p.precioVariable ? 'Desde ' : ''}$ ${p.precio.toLocaleString('es-CO')}`;
  const numero = (gid) => String(gid).split('/').pop();
  const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
  const origenTexto = (c) => (c.origen === 'Colección' ? `Colección «${c.coleccion ? c.coleccion.title : '—'}»` : `${c.origen} «${c.valor || '—'}»`);

  function pintarLista() {
    actual = null;
    document.title = 'Catálogos PDF';
    app.innerHTML = `
      <header class="cabecera">
        <div>
          <h1>Catálogos PDF</h1>
          <p class="sub">Toca un catálogo para ver sus productos, quitarlos, agregarlos u ordenarlos.</p>
        </div>
        <div class="acciones">
          <a class="boton" href="shopify://admin/content/metaobjects/entries/catalogo_ajustes" target="_top">Ajustes generales</a>
          <a class="boton boton--primario" href="shopify://admin/content/metaobjects/entries/catalogo_pdf/new" target="_top">Crear catálogo</a>
        </div>
      </header>
      <div class="catalogos">
        ${catalogos
          .map(
            (c) => `
          <a class="catalogo${c.activo ? '' : ' catalogo--apagado'}" href="#/${encodeURIComponent(c.slug)}">
            <span class="catalogo__portada">${c.portadaUrl ? `<img src="${esc(c.portadaUrl)}" alt="" loading="lazy">` : '<span class="catalogo__sinportada">PDF</span>'}</span>
            <span class="catalogo__info">
              <strong>${esc(c.titulo)}</strong>
              <span>${esc(origenTexto(c))}</span>
              <span>${c.productos} productos · ${fecha(c.actualizado)}</span>
              ${c.excluir.length || c.incluir.length ? `<span class="catalogo__ajustes">${c.excluir.length ? `${c.excluir.length} quitados` : ''}${c.excluir.length && c.incluir.length ? ' · ' : ''}${c.incluir.length ? `${c.incluir.length} agregados` : ''}</span>` : ''}
              ${c.activo ? '' : '<span class="etiqueta etiqueta--gris">Apagado</span>'}
            </span>
          </a>`
          )
          .join('')}
      </div>`;
  }

  async function abrirCatalogo(slug) {
    const cat = catalogos.find((c) => c.slug === slug);
    if (!cat) return pintarLista();
    document.title = `${cat.titulo} · Catálogos PDF`;
    app.innerHTML = `${barraVolver(cat)}<p class="cargando">Cargando productos de «${esc(cat.titulo)}»…</p>`;
    try {
      const base = await leerBase(cat);
      const productos = new Map(base.map((p) => [p.id, aProducto(p)]));
      const faltan = [...new Set([...cat.incluir, ...cat.excluir])].filter((id) => !productos.has(id));
      if (faltan.length) (await leerPorIds(faltan)).forEach((p) => productos.set(p.id, aProducto(p)));
      if (location.hash !== `#/${encodeURIComponent(slug)}`) return; // navigated away meanwhile
      actual = {
        ...cat,
        incluir: [...cat.incluir],
        excluir: [...cat.excluir],
        base: new Set(base.map((p) => p.id)),
        orderBase: base.map((p) => p.id),
        productos,
        busqueda: '',
      };
      pintarDetalle();
    } catch (e) {
      app.innerHTML = `${barraVolver(cat)}<p class="error">No se pudieron cargar los productos: ${esc(e.message)}</p>`;
    }
  }

  function barraVolver(cat) {
    return `<nav class="volver"><a href="#/">← Catálogos</a><span>${esc(cat.titulo)}</span></nav>`;
  }

  // Splits the products the way the generator will see them
  function clasificar() {
    const quitados = new Set(actual.excluir);
    const ids = [...actual.orderBase, ...actual.incluir.filter((id) => !actual.base.has(id))];
    const vistos = new Set();
    const enPdf = [];
    const fuera = [];
    for (const id of ids) {
      if (vistos.has(id) || quitados.has(id)) continue;
      vistos.add(id);
      const p = actual.productos.get(id);
      if (!p) continue;
      (p.estado === 'ok' ? enPdf : fuera).push(p);
    }
    const orden = ORDENES[actual.orden];
    if (orden) enPdf.sort(orden);
    const listaQuitados = actual.excluir.map((id) => actual.productos.get(id)).filter(Boolean);
    return { enPdf, fuera, listaQuitados };
  }

  function coincide(p) {
    const q = actual.busqueda.trim().toLowerCase();
    if (!q) return true;
    return `${p.title} ${p.sku}`.toLowerCase().includes(q);
  }

  function tarjeta(p, { n, boton, extra }) {
    return `
      <article class="producto${boton === 'volver' ? ' producto--quitado' : ''}">
        <div class="producto__foto">
          ${p.imagen ? `<img src="${esc(p.imagen)}" alt="" loading="lazy">` : '<span class="producto__sinfoto">Sin foto</span>'}
          ${n ? `<span class="producto__n">${n}</span>` : ''}
        </div>
        <div class="producto__texto">
          <h3>${esc(p.name)}</h3>
          <div class="producto__meta">
            ${p.reference ? `<span class="ref">Ref. ${esc(p.reference)}</span>` : ''}
            ${p.sku ? `<span class="sku">SKU ${esc(p.sku)}</span>` : ''}
          </div>
          <div class="producto__precio">${precioTexto(p)}${p.unitLabel ? ` <small>${esc(p.unitLabel)}</small>` : ''}</div>
          ${extra || ''}
        </div>
        ${
          boton === 'quitar'
            ? `<button class="boton boton--quitar" data-quitar="${esc(p.id)}">Quitar</button>`
            : boton === 'volver'
              ? `<button class="boton boton--volver" data-volver="${esc(p.id)}">Volver a incluir</button>`
              : ''
        }
      </article>`;
  }

  function pintarDetalle() {
    if (!actual) return;
    const { enPdf, fuera, listaQuitados } = clasificar();
    const enPdfVisibles = enPdf.map((p, i) => ({ p, n: i + 1 })).filter(({ p }) => coincide(p));
    const quitadosVisibles = listaQuitados.filter(coincide);
    const fueraVisibles = fuera.filter(coincide);
    const aMano = new Set(actual.incluir.filter((id) => !actual.base.has(id)));
    const abiertoFuera = app.querySelector('details.fuera') && app.querySelector('details.fuera').open;
    const foco = document.activeElement && document.activeElement.id === 'buscar';
    const scroll = window.scrollY;

    app.innerHTML = `
      ${barraVolver(actual)}
      <header class="cabecera cabecera--detalle">
        <div>
          <h1>${esc(actual.titulo)}</h1>
          <p class="sub">${esc(origenTexto(actual))}${actual.activo ? '' : ' · <strong>Apagado</strong>'}</p>
          <p class="resumen"><strong>${enPdf.length}</strong> en el PDF · <strong>${listaQuitados.length}</strong> quitados a mano · <strong>${fuera.length}</strong> no aparecen (sin foto, sin inventario o sin publicar)</p>
        </div>
        <div class="acciones">
          ${actual.pdfUrl ? `<a class="boton" href="${esc(actual.pdfUrl)}" target="_blank" rel="noopener">Ver PDF actual</a>` : ''}
          <a class="boton" href="shopify://admin/content/metaobjects/entries/catalogo_pdf/${numero(actual.id)}" target="_top">Más ajustes</a>
          <button class="boton boton--primario" id="agregar">+ Agregar productos</button>
        </div>
      </header>

      <div class="herramientas">
        <input id="buscar" type="search" placeholder="Buscar por nombre, referencia o SKU" value="${esc(actual.busqueda)}">
        <label class="orden">Orden
          <select id="orden">${ORDENES_LISTA.map((o) => `<option${o === actual.orden ? ' selected' : ''}>${esc(o === 'Como en la colección' && actual.origen !== 'Colección' ? 'Como en la colección (más nuevos)' : o)}</option>`).join('')}</select>
        </label>
      </div>
      <p class="nota">Los cambios se guardan solos. El PDF se actualiza en la siguiente actualización automática (máximo 1 hora).</p>

      <section>
        <h2>En el PDF <span class="contador">${enPdf.length}</span></h2>
        ${enPdfVisibles.length ? `<div class="productos">${enPdfVisibles.map(({ p, n }) => tarjeta(p, { n, boton: 'quitar', extra: aMano.has(p.id) ? '<span class="etiqueta etiqueta--verde">Agregado a mano</span>' : '' })).join('')}</div>` : `<p class="vacio">${actual.busqueda ? 'Ningún producto coincide con la búsqueda.' : 'No hay productos en el PDF.'}</p>`}
      </section>

      ${
        listaQuitados.length
          ? `<section>
        <h2>Quitados a mano <span class="contador">${listaQuitados.length}</span></h2>
        ${quitadosVisibles.length ? `<div class="productos">${quitadosVisibles.map((p) => tarjeta(p, { boton: 'volver' })).join('')}</div>` : '<p class="vacio">Ningún producto coincide con la búsqueda.</p>'}
      </section>`
          : ''
      }

      ${
        fuera.length
          ? `<details class="fuera"${abiertoFuera || actual.busqueda ? ' open' : ''}>
        <summary>No aparecen en el PDF <span class="contador">${fuera.length}</span> <small>Entran solos cuando tengan foto, inventario y estén publicados</small></summary>
        <div class="productos">${fueraVisibles.map((p) => tarjeta(p, { boton: aMano.has(p.id) ? 'quitar' : null, extra: `<span class="etiqueta etiqueta--gris">${MOTIVOS[p.estado]}</span>` })).join('')}</div>
      </details>`
          : ''
      }`;

    window.scrollTo(0, scroll);
    const buscar = document.getElementById('buscar');
    if (foco) {
      buscar.focus();
      buscar.setSelectionRange(buscar.value.length, buscar.value.length);
    }
  }

  // ---------- Events ----------

  app.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quitar]');
    if (q) return quitar(q.dataset.quitar);
    const v = e.target.closest('[data-volver]');
    if (v) return volver(v.dataset.volver);
    if (e.target.closest('#agregar')) agregar().catch((err) => aviso(`No se pudo agregar: ${err.message}`, null, true));
  });
  app.addEventListener('input', (e) => {
    if (e.target.id === 'buscar' && actual) {
      actual.busqueda = e.target.value;
      pintarDetalle();
    }
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'orden' && actual) cambiarOrden(ORDENES_LISTA[e.target.selectedIndex]);
  });

  function ruta() {
    const slug = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    if (slug) abrirCatalogo(slug);
    else pintarLista();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', ruta);

  leerCatalogos()
    .then((lista) => {
      catalogos = lista;
      ruta();
    })
    .catch((e) => {
      app.innerHTML = `<p class="error">No se pudieron leer los catálogos: ${esc(e.message)}</p>`;
    });
})();
