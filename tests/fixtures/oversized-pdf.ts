import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

function imagePixels(random = false): Buffer {
  const width = 750, height = 750;
  const pixels = Buffer.alloc(width * height * 3);
  if (random) { let value = 0x12345678; for (let offset = 0; offset < pixels.length; offset += 1) { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; pixels[offset] = value & 255; } return pixels; }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = (Math.floor(x / 25) + Math.floor(y / 25)) % 2 ? 255 : 0;
    pixels.fill(value, (y * width + x) * 3, (y * width + x + 1) * 3);
  }
  return pixels;
}
export function pdf(options: { pages?: number; catalog?: string; width?: number; extra?: string; randomPixels?: boolean; compressImages?: boolean; bombFirstImage?: boolean } = {}): Buffer {
  const pages = options.pages ?? 2;
  const objects: Buffer[] = [];
  const catalog = `<< /Type /Catalog /Pages 2 0 R ${options.catalog ?? ""} >>`;
  objects.push(Buffer.from(catalog));
  const childIds = Array.from({ length: pages }, (_, index) => `${3 + index * 3} 0 R`).join(" ");
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${childIds}] /Count ${pages} >>`));
  const pixels = imagePixels(options.randomPixels);
  for (let index = 0; index < pages; index += 1) {
    const imageId = 4 + index * 3, contentId = 5 + index * 3;
    const compressed = options.compressImages || (options.bombFirstImage && index === 0);
    const imageStream = compressed ? deflateSync(pixels) : pixels;
    const width = options.bombFirstImage && index === 0 ? 20000 : options.width ?? 750;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height 750 /ColorSpace /DeviceRGB /BitsPerComponent 8 ${compressed ? "/Filter /FlateDecode " : ""}/Length ${imageStream.length} >>\nstream\n`), imageStream, Buffer.from("\nendstream")]));
    const commands = Buffer.from("q 500 0 0 500 50 100 cm /Im0 Do Q");
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from("\nendstream")]));
  }
  const bytes: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0]; let length = bytes[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    bytes.push(part); length += part.length;
  }
  const xref = length;
  bytes.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`));
  for (const offset of offsets.slice(1)) bytes.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`));
  bytes.push(Buffer.from(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n${options.extra ?? ""}`));
  return Buffer.concat(bytes);
}
