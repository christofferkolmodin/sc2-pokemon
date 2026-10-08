import * as THREE from "three";

/**
 * Shared shader patches for three.js standard materials:
 * - `glow` vertex attribute -> emissive (flames, crystals, windows)
 * - rim light, so units read clearly against the ground like in SC2
 * - fog of war from a per-tile texture (0 = unexplored, 0.5 = explored, 1 = visible)
 */

export const shared = {
  fogTex: { value: null as THREE.Texture | null },
  fogOn: { value: 0 },
  mapSize: { value: new THREE.Vector2(1, 1) },
  time: { value: 0 },
};

const FOG_GLSL = /* glsl */ `
uniform sampler2D fogTex;
uniform float fogOn;
uniform vec2 mapSize;
vec3 applyFog(vec3 c, vec2 p) {
  if (fogOn < 0.5) return c;
  vec2 uv = p / mapSize;
  float v = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.25 : texture2D(fogTex, uv).r;
  float lit = v < 0.5 ? mix(0.07, 0.42, v * 2.0) : mix(0.42, 1.0, (v - 0.5) * 2.0);
  vec3 grey = vec3(dot(c, vec3(0.3, 0.59, 0.11))) * vec3(0.82, 0.88, 1.0);
  return mix(grey, c, smoothstep(0.55, 1.0, v)) * lit;
}
`;

export interface PatchOpts {
  glow?: boolean;
  rim?: number;
  fog?: boolean;
  /** Extra fragment code run on diffuseColor (e.g. terrain detail). */
  extraFragHead?: string;
  extraFragColor?: string;
  extraUniforms?: Record<string, THREE.IUniform>;
}

export function patch(mat: THREE.MeshStandardMaterial, o: PatchOpts) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.fogTex = shared.fogTex;
    shader.uniforms.fogOn = shared.fogOn;
    shader.uniforms.mapSize = shared.mapSize;
    shader.uniforms.time = shared.time;
    if (o.extraUniforms) Object.assign(shader.uniforms, o.extraUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        ${o.glow ? "attribute float glow; varying float vGlow;" : ""}`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          wp = modelMatrix * wp;
          vWPos = wp.xyz;
          vWNrm = normalize(mat3(modelMatrix) * wn);
        }
        ${o.glow ? "vGlow = glow;" : ""}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float time;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        ${o.glow ? "varying float vGlow;" : ""}
        ${FOG_GLSL}
        ${o.extraFragHead ?? ""}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        ${o.extraFragColor ?? ""}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        ${o.glow ? "totalEmissiveRadiance += diffuseColor.rgb * vGlow * 1.8;" : ""}`,
      )
      .replace(
        "#include <opaque_fragment>",
        `${
          o.rim
            ? `{
          float rim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);
          outgoingLight += vec3(0.42, 0.52, 0.65) * rim * ${o.rim.toFixed(3)} * (0.5 + 0.5 * diffuseColor.rgb);
        }`
            : ""
        }
        ${o.fog ? "outgoingLight = applyFog(outgoingLight, vWPos.xz);" : ""}
        #include <opaque_fragment>`,
      );
  };
  // Distinct cache keys so three doesn't reuse a program compiled without the patch.
  mat.customProgramCacheKey = () => `p${o.glow ? 1 : 0}${o.rim ?? 0}${o.fog ? 1 : 0}${(o.extraFragColor ?? "").length}`;
  return mat;
}

/** Material for units and structures (vertex colours, glow, rim, fog). */
export function unitMaterial(fog = true): THREE.MeshStandardMaterial {
  return patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0 }), { glow: true, rim: 0.55, fog });
}

/** Material for doodads (vertex colours, glow, fog, a little less rim). */
export function propMaterial(): THREE.MeshStandardMaterial {
  return patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0, flatShading: false }), { glow: true, rim: 0.2, fog: true });
}
