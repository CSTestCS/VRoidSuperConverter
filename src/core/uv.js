// UV origin bookkeeping. glTF/VRM store UVs with the origin at the top-left of the texture
// (V grows downwards; three.js loads such textures with flipY = false), while FBX and COLLADA
// use a bottom-left origin. Geometry loaded from glTF is marked so exporters can convert.

export function markTopLeftUVs(root) {
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes.uv) o.geometry.userData.uvOrigin = 'top-left'; });
}

/** True when the mesh's UVs use the glTF (top-left) convention. */
export function hasTopLeftUVs(mesh) {
  if (mesh.geometry?.userData?.uvOrigin) return mesh.geometry.userData.uvOrigin === 'top-left';
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => m?.map && m.map.flipY === false);
}

/** V coordinate for formats with a bottom-left origin (FBX, COLLADA). */
export const bottomLeftV = (mesh) => (hasTopLeftUVs(mesh) ? (v) => 1 - v : (v) => v);
