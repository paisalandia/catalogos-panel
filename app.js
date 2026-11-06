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
    // Same price: newest first
    'Precio: menor a mayor': (a, b) => a.precio - b.precio || b.creado.localeCompare(a.creado),
    'Precio: mayor a menor': (a, b) => b.precio - a.precio || b.creado.localeCompare(a.creado),
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
  let gestion = null; // inventory/order settings and the last hourly run (metaobject inventario_ajustes)

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
      ${secciones('catalogos')}
      <header class="cabecera">
        <div>
          <h1>Catálogos PDF</h1>
          <p class="sub">Toca un catálogo para ver sus productos, quitarlos, agregarlos, ordenarlos o ver su historial.</p>
          ${gestion && gestion.revision ? `<p class="sub">Última revisión automática: <strong>${fechaHora(gestion.revision.fecha)}</strong></p>` : ''}
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

  function barraVolver(cat, vista = 'productos') {
    const slug = encodeURIComponent(cat.slug);
    return `<nav class="volver"><a href="#/">← Catálogos</a><span>${esc(cat.titulo)}</span></nav>
      <nav class="pestanas pestanas--chicas">
        <a href="#/${slug}"${vista === 'productos' ? ' aria-current="page"' : ''}>Productos</a>
        <a href="#/${slug}/historial"${vista === 'historial' ? ' aria-current="page"' : ''}>Historial de cambios</a>
      </nav>`;
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

  // Ignores accents and case; every typed word must appear somewhere in the title or SKU
  const normalizar = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  function coincide(p) {
    const palabras = normalizar(actual.busqueda).split(/\s+/).filter(Boolean);
    if (!palabras.length) return true;
    const texto = normalizar(`${p.title} ${p.sku}`);
    return palabras.every((w) => texto.includes(w));
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

  // ---------- Gestión: history, inventory rules and photo-less order ----------
  // The hourly job (GitHub Actions, repo catalogos-paisalandia) does the work; these views show what
  // it did and change its settings in the metaobject "inventario_ajustes" (entry "general").

  const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const pesos = (n) => `$ ${Number(n || 0).toLocaleString('es-CO')}`;

  function secciones(activa) {
    const item = (id, href, texto) => `<a href="${href}"${activa === id ? ' aria-current="page"' : ''}>${texto}</a>`;
    return `<nav class="pestanas">${item('catalogos', '#/', 'Catálogos')}${item('inventario', '#/inventario', 'Inventario')}${item('orden', '#/orden', 'Orden de colecciones')}</nav>`;
  }

  async function leerGestion() {
    const { metaobjectByHandle: m } = await gql(`{ metaobjectByHandle(handle: { type: "inventario_ajustes", handle: "general" }) { id fields { key value } } }`);
    if (!m) return null;
    const f = Object.fromEntries(m.fields.map((x) => [x.key, x.value]));
    let revision = null;
    try {
      revision = JSON.parse(f.ultima_revision || 'null');
    } catch (e) {
      revision = null;
    }
    return {
      id: m.id,
      activo: f.activo === 'true',
      limiteUnd: Number(f.limite_und || 10),
      limiteDc: Number(f.limite_dc || 3),
      reactivarAntiguos: f.reactivar_antiguos === 'true',
      ordenSinFoto: f.orden_sin_foto === 'true',
      ordenColecciones: f.orden_colecciones || 'Precio: menor a mayor',
      revision,
    };
  }

  async function guardarGestion(campos, mensaje) {
    const fields = Object.entries(campos).map(([key, value]) => ({ key, value: String(value) }));
    const data = await gql(`mutation($id: ID!, $m: MetaobjectUpdateInput!) { metaobjectUpdate(id: $id, metaobject: $m) { userErrors { field message } } }`, { id: gestion.id, m: { fields } });
    const err = data.metaobjectUpdate.userErrors[0];
    if (err) throw new Error(err.message);
    aviso(mensaje);
  }

  async function refrescarGestion() {
    gestion = await leerGestion();
  }

  // Catalog change history (metaobject "catalogo_historial"), newest first
  async function pintarHistorialCatalogo(slug) {
    const cat = catalogos.find((c) => c.slug === slug);
    if (!cat) return pintarLista();
    actual = null;
    document.title = `Historial · ${cat.titulo}`;
    app.innerHTML = `${barraVolver(cat, 'historial')}<p class="cargando">Cargando historial…</p>`;
    try {
      const { metaobjects } = await gql(
        `query($q: String!) { metaobjects(type: "catalogo_historial", first: 100, sortKey: "updated_at", reverse: true, query: $q) { nodes { fields { key value } } } }`,
        { q: `fields.catalogo:"${cat.id}"` }
      );
      const entradas = metaobjects.nodes
        .map((m) => Object.fromEntries(m.fields.map((x) => [x.key, x.value])))
        .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
      const lista = (titulo, items, fila) =>
        items && items.length ? `<details class="cambio__grupo"><summary>${titulo} (${items.length})</summary><ul>${items.map((x) => `<li>${fila(x)}</li>`).join('')}</ul></details>` : '';
      app.innerHTML = `
        ${barraVolver(cat, 'historial')}
        <header class="cabecera"><div>
          <h1>Historial de ${esc(cat.titulo)}</h1>
          <p class="sub">Cada vez que el catálogo cambia en la revisión automática (cada hora) queda un registro: qué productos entraron, cuáles salieron y por qué, y qué precios cambiaron. Se guardan los últimos 120 días.</p>
        </div></header>
        ${
          entradas.length
            ? `<ol class="cambios">${entradas
                .map((e) => {
                  let d = {};
                  try {
                    d = JSON.parse(e.detalle || '{}');
                  } catch (err) {
                    d = {};
                  }
                  const chips = [
                    Number(e.agregados) ? `<span class="chip chip--verde">+${e.agregados} agregados</span>` : '',
                    Number(e.quitados) ? `<span class="chip chip--rojo">−${e.quitados} quitados</span>` : '',
                    Number(e.precios) ? `<span class="chip">${e.precios} precios</span>` : '',
                  ].join('');
                  return `<li class="cambio">
                    <div class="cambio__cabeza"><strong>${fechaHora(e.fecha)}</strong><span>${esc(e.total)} productos en el PDF</span></div>
                    <div class="cambio__chips">${chips || `<span class="chip">${esc(e.resumen)}</span>`}</div>
                    ${lista('Agregados', d.agregados, (x) => `${esc(x.sku || 's/SKU')} · ${esc(x.nombre)} · ${pesos(x.precio)}`)}
                    ${lista('Quitados', d.quitados, (x) => `${esc(x.sku || 's/SKU')} · ${esc(x.nombre)} <span class="etiqueta etiqueta--gris">${esc(x.motivo)}</span>`)}
                    ${lista('Cambios de precio', d.precios, (x) => `${esc(x.sku || 's/SKU')} · ${esc(x.nombre)} · ${pesos(x.antes)} → <strong>${pesos(x.ahora)}</strong>`)}
                  </li>`;
                })
                .join('')}</ol>`
            : '<p class="vacio">Aún no hay cambios registrados. El historial empieza con la próxima revisión automática.</p>'
        }`;
    } catch (e) {
      app.innerHTML = `${barraVolver(cat, 'historial')}<p class="error">No se pudo leer el historial: ${esc(e.message)}</p>`;
    }
  }

  // Inventory rules: settings, what the last run did (or would do) and the change log
  let filtroInventario = '';
  async function pintarInventario(despues = null) {
    actual = null;
    document.title = 'Inventario · Gestión Paisalandia';
    if (!despues) app.innerHTML = `${secciones('inventario')}<p class="cargando">Cargando inventario…</p>`;
    try {
      await refrescarGestion();
      if (!gestion) throw new Error('Faltan los ajustes de inventario');
      const q = filtroInventario ? `fields.accion:${filtroInventario}` : '';
      const [{ metaobjects }, conteo] = await Promise.all([
        gql(
          `query($q: String, $after: String) { metaobjects(type: "inventario_historial", first: 100, after: $after, sortKey: "updated_at", reverse: true, query: $q) { nodes { fields { key value } } pageInfo { hasNextPage endCursor } } }`,
          { q, after: despues }
        ),
        gql(`{ productsCount(query: "status:draft tag:oculto-por-inventario", limit: null) { count } }`),
      ]);
      const filas = metaobjects.nodes.map((m) => Object.fromEntries(m.fields.map((x) => [x.key, x.value])));
      const r = gestion.revision && gestion.revision.inventario;
      const ejemplos = (titulo, items) =>
        items && items.length ? `<details class="cambio__grupo"><summary>${titulo}</summary><ul>${items.map((x) => `<li>${esc(x.sku || 's/SKU')} · ${esc(x.titulo)} · inventario ${esc(x.inventario)} (límite ${esc(x.limite)})</li>`).join('')}</ul></details>` : '';
      app.innerHTML = `
        ${secciones('inventario')}
        <header class="cabecera"><div>
          <h1>Inventario</h1>
          <p class="sub">Cada hora se ocultan (pasan a borrador) los productos con poco inventario y vuelven a activarse cuando se les ingresa mercancía. Los de docena (DC) se cuentan en docenas.</p>
        </div></header>

        <section class="tarjeta">
          <h2>Reglas</h2>
          <label class="interruptor"><input type="checkbox" id="inv-activo"${gestion.activo ? ' checked' : ''}> <span><strong>Reglas activas</strong><br><small>Apagado: no cambia nada, solo muestra abajo qué haría.</small></span></label>
          <div class="campos">
            <label>Ocultar UND y otras unidades con<input type="number" min="0" id="inv-und" value="${gestion.limiteUnd}"><small>unidades o menos</small></label>
            <label>Ocultar DC (docena) con<input type="number" min="0" id="inv-dc" value="${gestion.limiteDc}"><small>docenas o menos</small></label>
          </div>
          <label class="interruptor"><input type="checkbox" id="inv-antiguos"${gestion.reactivarAntiguos ? ' checked' : ''}> <span><strong>Reactivar también borradores antiguos</strong><br><small>Incluye borradores con foto que no ocultó esta app (por ejemplo, los del Flow anterior) cuando su inventario supere el límite.</small></span></label>
          <button class="boton boton--primario" id="inv-guardar">Guardar reglas</button>
          <p class="nota">Los cambios se aplican en la próxima revisión automática (máximo 1 hora).</p>
        </section>

        <section class="tarjeta">
          <h2>Última revisión ${gestion.revision ? `· ${fechaHora(gestion.revision.fecha)}` : ''}</h2>
          ${
            r
              ? r.activo
                ? `<p><strong>${r.ocultados}</strong> productos ocultados · <strong>${r.reactivados}</strong> reactivados.</p>`
                : `<p class="aviso-simulacion">Modo simulación: si activas las reglas, se ocultarían <strong>${r.ocultar}</strong> productos y se reactivarían <strong>${r.reactivar}</strong>${r.antiguos ? `, y <strong>${r.antiguos}</strong> borradores antiguos si activas esa opción` : ''}.</p>
                   ${ejemplos(`Se ocultarían (${r.ocultar})`, r.ejemplos && r.ejemplos.ocultar)}
                   ${ejemplos(`Se reactivarían (${r.reactivar})`, r.ejemplos && r.ejemplos.reactivar)}
                   ${ejemplos(`Borradores antiguos que podrían volver (${r.antiguos})`, r.ejemplos && r.ejemplos.antiguos)}`
              : '<p class="vacio">Todavía no hay una revisión con estas reglas.</p>'
          }
          <p>Ocultos ahora por esta app: <strong>${conteo.productsCount.count}</strong> productos.</p>
        </section>

        <section>
          <h2>Historial</h2>
          <div class="herramientas">
            <select id="inv-filtro">
              <option value=""${!filtroInventario ? ' selected' : ''}>Todos los cambios</option>
              <option value="Ocultado"${filtroInventario === 'Ocultado' ? ' selected' : ''}>Solo ocultados</option>
              <option value="Reactivado"${filtroInventario === 'Reactivado' ? ' selected' : ''}>Solo reactivados</option>
            </select>
          </div>
          ${
            filas.length
              ? `<div class="tabla-envoltura"><table class="tabla"><thead><tr><th>Fecha</th><th>Acción</th><th>Producto</th><th>Inventario</th></tr></thead><tbody>${filas
                  .map(
                    (x) => `<tr>
                      <td>${fechaHora(x.fecha)}</td>
                      <td><span class="chip ${x.accion === 'Ocultado' ? 'chip--rojo' : 'chip--verde'}">${esc(x.accion)}</span></td>
                      <td><a href="shopify://admin/products/${numero(x.producto)}" target="_top">${esc(x.titulo)}</a><br><small>${esc(x.sku || '')}</small></td>
                      <td>${esc(x.inventario)} ${x.unidad === 'DC' ? 'doc.' : 'und.'} <small>(límite ${esc(x.limite)})</small></td>
                    </tr>`
                  )
                  .join('')}</tbody></table></div>
                 ${metaobjects.pageInfo.hasNextPage ? `<button class="boton" id="inv-mas" data-cursor="${esc(metaobjects.pageInfo.endCursor)}">Ver más antiguos</button>` : ''}`
              : '<p class="vacio">Aún no hay cambios registrados.</p>'
          }
        </section>`;
    } catch (e) {
      app.innerHTML = `${secciones('inventario')}<p class="error">No se pudo cargar el inventario: ${esc(e.message)}</p>`;
    }
  }

  async function pintarOrden() {
    actual = null;
    document.title = 'Orden de colecciones · Gestión Paisalandia';
    app.innerHTML = `${secciones('orden')}<p class="cargando">Cargando…</p>`;
    try {
      await refrescarGestion();
      if (!gestion) throw new Error('Faltan los ajustes');
      const o = gestion.revision && gestion.revision.orden;
      app.innerHTML = `
        ${secciones('orden')}
        <header class="cabecera"><div>
          <h1>Orden de las colecciones</h1>
          <p class="sub">Cada hora, todas las colecciones se ordenan con el criterio que elijas aquí, y los productos sin foto siempre quedan al final. Los productos ocultos (sin inventario) no se ven en la tienda. Las colecciones quedan en orden manual porque así Shopify deja que la app las ordene.</p>
        </div></header>
        <section class="tarjeta">
          <label class="interruptor"><input type="checkbox" id="orden-activo"${gestion.ordenSinFoto ? ' checked' : ''}> <span><strong>Ordenar colecciones automáticamente</strong><br><small>Apagado: no cambia nada, solo muestra abajo qué haría.</small></span></label>
          <div class="campos">
            <label>Orden de las colecciones
              <select id="orden-criterio">
                ${['Precio: menor a mayor', 'Más nuevos primero'].map((o) => `<option${o === gestion.ordenColecciones ? ' selected' : ''}>${o}</option>`).join('')}
              </select>
              <small>Con «Precio: menor a mayor», a igual precio salen primero los más nuevos.</small>
            </label>
          </div>
          <button class="boton boton--primario" id="orden-guardar">Guardar</button>
        </section>
        <section class="tarjeta">
          <h2>Última revisión ${gestion.revision ? `· ${fechaHora(gestion.revision.fecha)}` : ''}</h2>
          ${
            o
              ? `<p${o.activo ? '' : ' class="aviso-simulacion"'}>${o.activo ? '' : 'Modo simulación: '}${o.movidos} productos ${o.activo ? 'movidos' : 'se moverían'} en ${o.colecciones} colecciones.${
                  o.pasadasAManual && o.pasadasAManual.length ? ` Colecciones que ${o.activo ? 'pasaron' : 'pasarían'} a orden manual: ${o.pasadasAManual.map(esc).join(', ')}.` : ''
                }</p>
                ${
                  o.detalle && o.detalle.length
                    ? `<div class="tabla-envoltura"><table class="tabla"><thead><tr><th>Colección</th><th>Sin foto</th><th>Movimientos</th></tr></thead><tbody>${o.detalle
                        .map((d) => `<tr><td>${esc(d.coleccion)}</td><td>${esc(d.sinFoto)}</td><td>${esc(d.movimientos)}</td></tr>`)
                        .join('')}</tbody></table></div>`
                    : '<p>Todas las colecciones ya tienen los productos sin foto al final.</p>'
                }`
              : '<p class="vacio">Todavía no hay una revisión.</p>'
          }
          <p class="nota">La búsqueda de la tienda y la página «Todos los productos» no se pueden ordenar desde una app; ahí Shopify usa su propio orden.</p>
        </section>`;
    } catch (e) {
      app.innerHTML = `${secciones('orden')}<p class="error">No se pudo cargar: ${esc(e.message)}</p>`;
    }
  }

  // ---------- Events ----------

  app.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quitar]');
    if (q) return quitar(q.dataset.quitar);
    const v = e.target.closest('[data-volver]');
    if (v) return volver(v.dataset.volver);
    if (e.target.closest('#agregar')) agregar().catch((err) => aviso(`No se pudo agregar: ${err.message}`, null, true));
    if (e.target.closest('#inv-guardar')) {
      const und = Number(document.getElementById('inv-und').value);
      const dc = Number(document.getElementById('inv-dc').value);
      if (!(und >= 0) || !(dc >= 0)) return aviso('Los límites deben ser números de 0 en adelante', null, true);
      guardarGestion(
        {
          activo: document.getElementById('inv-activo').checked,
          limite_und: Math.round(und),
          limite_dc: Math.round(dc),
          reactivar_antiguos: document.getElementById('inv-antiguos').checked,
        },
        'Reglas guardadas; se aplican en la próxima revisión'
      ).catch((err) => aviso(`No se pudo guardar: ${err.message}`, null, true));
    }
    if (e.target.closest('#orden-guardar')) {
      guardarGestion({ orden_sin_foto: document.getElementById('orden-activo').checked, orden_colecciones: document.getElementById('orden-criterio').value },'Guardado; se aplica en la próxima revisión').catch((err) =>
        aviso(`No se pudo guardar: ${err.message}`, null, true)
      );
    }
    const mas = e.target.closest('#inv-mas');
    if (mas) pintarInventario(mas.dataset.cursor);
  });
  app.addEventListener('input', (e) => {
    if (e.target.id === 'buscar' && actual) {
      actual.busqueda = e.target.value;
      pintarDetalle();
    }
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'orden' && actual) cambiarOrden(ORDENES_LISTA[e.target.selectedIndex]);
    if (e.target.id === 'inv-filtro') {
      filtroInventario = e.target.value;
      pintarInventario();
    }
  });

  function ruta() {
    const [slug, sub] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
    if (slug === 'inventario') pintarInventario();
    else if (slug === 'orden') pintarOrden();
    else if (slug && sub === 'historial') pintarHistorialCatalogo(slug);
    else if (slug) abrirCatalogo(slug);
    else pintarLista();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', ruta);

  Promise.all([leerCatalogos(), leerGestion().catch(() => null)])
    .then(([lista, g]) => {
      catalogos = lista;
      gestion = g;
      ruta();
    })
    .catch((e) => {
      app.innerHTML = `<p class="error">No se pudieron leer los catálogos: ${esc(e.message)}</p>`;
    });
})();
