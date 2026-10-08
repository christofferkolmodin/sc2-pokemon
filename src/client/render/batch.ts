import * as THREE from "three";

/** An InstancedMesh that grows on demand and is refilled every frame. */
export class Batch {
  mesh: THREE.InstancedMesh;
  count = 0;
  private color = new THREE.Color();

  constructor(
    readonly geo: THREE.BufferGeometry,
    readonly mat: THREE.Material,
    private parent: THREE.Object3D,
    private cap = 64,
    readonly shadows = true,
  ) {
    this.mesh = this.make(cap);
  }

  private make(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.castShadow = this.shadows;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    this.parent.add(m);
    return m;
  }

  begin() {
    this.count = 0;
  }

  push(matrix: THREE.Matrix4, r = 1, g = 1, b = 1) {
    if (this.count >= this.cap) {
      const old = this.mesh;
      this.cap *= 2;
      this.mesh = this.make(this.cap);
      this.mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      this.mesh.instanceColor!.array.set(old.instanceColor!.array);
      this.parent.remove(old);
      old.dispose();
    }
    matrix.toArray(this.mesh.instanceMatrix.array, this.count * 16);
    this.color.setRGB(r, g, b);
    this.color.toArray(this.mesh.instanceColor!.array, this.count * 3);
    this.count++;
  }

  end() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
