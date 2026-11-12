import { Warehouse } from '@/index';

export function seedWarehouse(): Warehouse {
  const w = new Warehouse();
  w.receive('BOLT-01', 50);
  w.receive('NUT-02', 5);
  w.receive('SCREW-03', 12);
  return w;
}
