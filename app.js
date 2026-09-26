(function () {
  const COLOR_RAMP = {
    minMeters: 5,
    maxMeters: 45,
    stops: [
      { meters: 5, rgb: [36, 108, 112] },
      { meters: 15, rgb: [74, 148, 122] },
      { meters: 25, rgb: [188, 178, 96] },
      { meters: 35, rgb: [176, 108, 52] },
      { meters: 45, rgb: [122, 52, 28] },
    ],
  };

  const GSI_ATTR =
    '<a href="https://maps.gsi.go.jp/development/ichiran.html">出典：国土地理院</a>, ' +
    '<a href="https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html">地理院タイル</a>, ' +
    "標高タイル（基盤地図情報数値標高モデル）を加工して作成";

  function decodeDemPixel(r, g, b) {
    const x = 65536 * r + 256 * g + b;
    if (x === 8388608) return null;
    if (x < 8388608) return x * 0.01;
    return (x - 16777216) * 0.01;
  }

  function colorForMeters(meters, ramp) {
    if (meters === null || meters === undefined || Number.isNaN(meters)) {
      return null;
    }
    const stops = ramp.stops;
    if (meters <= stops[0].meters) return stops[0].rgb.slice();
    const last = stops[stops.length - 1];
    if (meters >= last.meters) return last.rgb.slice();
    for (let i = 1; i < stops.length; i += 1) {
      const lo = stops[i - 1];
      const hi = stops[i];
      if (meters <= hi.meters) {
        const t = (meters - lo.meters) / (hi.meters - lo.meters);
        return [
          Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * t),
          Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * t),
          Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * t),
        ];
      }
    }
    return last.rgb.slice();
  }

  function rampGradientCss(ramp) {
    const span = ramp.maxMeters - ramp.minMeters;
    const parts = ramp.stops.map(function (stop) {
      const pct = ((stop.meters - ramp.minMeters) / span) * 100;
      return (
        "rgb(" +
        stop.rgb[0] +
        ", " +
        stop.rgb[1] +
        ", " +
        stop.rgb[2] +
        ") " +
        pct +
        "%"
      );
    });
    return "linear-gradient(90deg, " + parts.join(", ") + ")";
  }

  function demNativeZoom(z) {
    return z >= 15 ? 15 : z;
  }

  function demTileUrl(z, x, y) {
    const nativeZ = demNativeZoom(z);
    const layer = nativeZ >= 15 ? "dem5a_png" : "dem_png";
    return (
      "https://cyberjapandata.gsi.go.jp/xyz/" +
      layer +
      "/" +
      nativeZ +
      "/" +
      x +
      "/" +
      y +
      ".png"
    );
  }

  function boundsOf(geojson) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    walkRings(geojson, function (ring) {
      for (let i = 0; i < ring.length; i += 1) {
        const lon = ring[i][0];
        const lat = ring[i][1];
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    });
    return { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat };
  }

  function walkRings(geojson, visit) {
    const geom = geojson.features[0].geometry;
    const polygons =
      geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    for (let p = 0; p < polygons.length; p += 1) {
      for (let r = 0; r < polygons[p].length; r += 1) {
        visit(polygons[p][r], r === 0, p);
      }
    }
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const crosses = yi > lat !== yj > lat;
      if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInWard(lon, lat, geojson) {
    const geom = geojson.features[0].geometry;
    const polygons =
      geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    for (let p = 0; p < polygons.length; p += 1) {
      const rings = polygons[p];
      if (!pointInRing(lon, lat, rings[0])) continue;
      let hole = false;
      for (let r = 1; r < rings.length; r += 1) {
        if (pointInRing(lon, lat, rings[r])) {
          hole = true;
          break;
        }
      }
      if (!hole) return true;
    }
    return false;
  }

  function lonLatToTilePixel(lon, lat, z, tileSize) {
    const n = Math.pow(2, z);
    const x = ((lon + 180) / 360) * n;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const y =
      (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    let px = Math.floor((x - tileX) * tileSize);
    let py = Math.floor((y - tileY) * tileSize);
    if (px >= tileSize) px = tileSize - 1;
    if (py >= tileSize) py = tileSize - 1;
    if (px < 0) px = 0;
    if (py < 0) py = 0;
    return { z: z, x: tileX, y: tileY, px: px, py: py };
  }

  function tileTouchesBBox(coords, tileSize, bbox) {
    const z = coords.z;
    const nw = L.CRS.EPSG3857.pointToLatLng(
      L.point(coords.x * tileSize, coords.y * tileSize),
      z
    );
    const se = L.CRS.EPSG3857.pointToLatLng(
      L.point((coords.x + 1) * tileSize, (coords.y + 1) * tileSize),
      z
    );
    const tileMinLon = nw.lng;
    const tileMaxLat = nw.lat;
    const tileMaxLon = se.lng;
    const tileMinLat = se.lat;
    return !(
      tileMaxLon < bbox.minLon ||
      tileMinLon > bbox.maxLon ||
      tileMinLat > bbox.maxLat ||
      tileMaxLat < bbox.minLat
    );
  }

  function paintWardMask(ctx, coords, tileSize, geojson) {
    ctx.beginPath();
    walkRings(geojson, function (ring) {
      for (let i = 0; i < ring.length; i += 1) {
        const point = L.CRS.EPSG3857.latLngToPoint(
          L.latLng(ring[i][1], ring[i][0]),
          coords.z
        );
        const x = point.x - coords.x * tileSize;
        const y = point.y - coords.y * tileSize;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    });
    ctx.fill("evenodd");
  }

  function colorizeImageData(imageData, ramp) {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const meters = decodeDemPixel(data[i], data[i + 1], data[i + 2]);
      const rgb = colorForMeters(meters, ramp);
      if (!rgb) {
        data[i + 3] = 0;
        continue;
      }
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }

  const ElevationColorLayer = L.GridLayer.extend({
    initialize: function (ramp, wardGeojson, options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this.ramp = ramp;
      this.wardGeojson = wardGeojson;
      this.wardBBox = boundsOf(wardGeojson);
    },

    createTile: function (coords, done) {
      const tileSize = this.getTileSize().x;
      const canvas = L.DomUtil.create("canvas", "elevation-tile");
      canvas.width = tileSize;
      canvas.height = tileSize;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      if (!tileTouchesBBox(coords, tileSize, this.wardBBox)) {
        setTimeout(function () {
          done(null, canvas);
        }, 0);
        return canvas;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      const ramp = this.ramp;
      const wardGeojson = this.wardGeojson;
      img.onload = function () {
        try {
          ctx.drawImage(img, 0, 0, tileSize, tileSize);
          const imageData = ctx.getImageData(0, 0, tileSize, tileSize);
          colorizeImageData(imageData, ramp);
          ctx.putImageData(imageData, 0, 0);
          ctx.save();
          ctx.globalCompositeOperation = "destination-in";
          paintWardMask(ctx, coords, tileSize, wardGeojson);
          ctx.restore();
          done(null, canvas);
        } catch (err) {
          done(err, canvas);
        }
      };
      img.onerror = function () {
        done(null, canvas);
      };
      img.src = demTileUrl(coords.z, coords.x, coords.y);
      return canvas;
    },
  });

  const demTileCache = new Map();

  function loadDemTile(z, x, y) {
    const key = z + "/" + x + "/" + y;
    if (demTileCache.has(key)) return demTileCache.get(key);
    const promise = new Promise(function (resolve, reject) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = function () {
        reject(new Error("dem tile missing"));
      };
      img.src = demTileUrl(z, x, y);
    });
    demTileCache.set(key, promise);
    return promise;
  }

  async function sampleElevation(lon, lat, z) {
    const sample = { lon: lon, lat: lat, meters: null };
    const pixel = lonLatToTilePixel(lon, lat, z, 256);
    try {
      const imageData = await loadDemTile(pixel.z, pixel.x, pixel.y);
      const i = (pixel.py * imageData.width + pixel.px) * 4;
      sample.meters = decodeDemPixel(
        imageData.data[i],
        imageData.data[i + 1],
        imageData.data[i + 2]
      );
    } catch (err) {
      sample.meters = null;
    }
    return sample;
  }

  function paintLegend(ramp) {
    document.getElementById("legend-bar").style.backgroundImage =
      rampGradientCss(ramp);
    document.getElementById("legend-min").textContent = String(ramp.minMeters);
    document.getElementById("legend-max").textContent = String(ramp.maxMeters);
  }

  function showReadout(text, empty) {
    const el = document.getElementById("readout");
    el.textContent = text;
    el.classList.toggle("is-empty", Boolean(empty));
  }

  async function start() {
    paintLegend(COLOR_RAMP);
    showReadout("", true);

    const response = await fetch("data/shinjuku.geojson");
    if (!response.ok) {
      showReadout("区界データを読めませんでした", true);
      return;
    }
    const ward = await response.json();
    const bbox = boundsOf(ward);
    const bounds = L.latLngBounds(
      [bbox.minLat, bbox.minLon],
      [bbox.maxLat, bbox.maxLon]
    );

    const map = L.map("map", {
      minZoom: 12,
      maxZoom: 17,
      zoomSnap: 1,
      zoomControl: true,
      attributionControl: true,
      maxBounds: bounds.pad(0.45),
      maxBoundsViscosity: 0.85,
    });

    map.createPane("elevation");
    map.getPane("elevation").style.zIndex = 350;
    map.getPane("elevation").style.mixBlendMode = "multiply";
    map.getPane("elevation").style.pointerEvents = "none";

    L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      attribution: GSI_ATTR,
      minZoom: 12,
      maxZoom: 17,
      maxNativeZoom: 18,
    }).addTo(map);

    new ElevationColorLayer(COLOR_RAMP, ward, {
      pane: "elevation",
      tileSize: 256,
      minZoom: 12,
      maxZoom: 17,
      maxNativeZoom: 15,
      opacity: 1,
    }).addTo(map);

    L.geoJSON(ward, {
      style: {
        color: "#1b2a22",
        weight: 1.4,
        opacity: 0.9,
        fill: false,
      },
      interactive: false,
    }).addTo(map);

    map.getContainer()._leaflet_map = map;

    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 14 });
    if (map.getZoom() < 13) map.setZoom(14);

    map.on("click", async function (event) {
      const lon = event.latlng.lng;
      const lat = event.latlng.lat;
      if (!pointInWard(lon, lat, ward)) {
        showReadout("新宿区の外です", true);
        return;
      }
      const z = demNativeZoom(Math.max(12, Math.min(17, map.getZoom())));
      const sample = await sampleElevation(lon, lat, z);
      if (sample.meters === null) {
        showReadout("標高データがありません", true);
        return;
      }
      showReadout(sample.meters.toFixed(1) + " m", false);
    });
  }

  start().catch(function () {
    showReadout("地図を初期化できませんでした", true);
  });
})();
