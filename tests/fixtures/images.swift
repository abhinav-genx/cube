// Test images for tests/strip.test.mjs, written and checked with Apple's ImageIO (the decoder iOS uses).
//
//   swift tests/fixtures/images.swift make tests/fixtures
//       writes photo.jpg, photo.heic, photo.png: a 64x48 gradient with GPS, camera, lens,
//       serial-number and owner tags, orientation 6 and a capture date.
//   swift tests/fixtures/images.swift check original stripped
//       decodes both and fails unless the pixels are identical, orientation and date survive,
//       and no GPS or camera details are left.
import Foundation
import ImageIO
import UniformTypeIdentifiers

func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }

func gradient() -> CGImage {
  let w = 64, h = 48
  var px = [UInt8](repeating: 0, count: w * h * 4)
  for y in 0..<h { for x in 0..<w {
    let i = (y * w + x) * 4
    px[i] = UInt8(x * 4); px[i + 1] = UInt8(y * 5); px[i + 2] = UInt8((x + y) * 2); px[i + 3] = 255
  } }
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  return ctx.makeImage()!
}

let props: [CFString: Any] = [
  kCGImagePropertyOrientation: 6,
  kCGImagePropertyTIFFDictionary: [
    kCGImagePropertyTIFFMake: "CubeTestMake", kCGImagePropertyTIFFModel: "CubeTestModel",
    kCGImagePropertyTIFFSoftware: "CubeTestSoftware", kCGImagePropertyTIFFOrientation: 6,
  ],
  kCGImagePropertyExifDictionary: [
    kCGImagePropertyExifDateTimeOriginal: "2025:06:01 12:34:56",
    kCGImagePropertyExifLensMake: "CubeTestLensMake", kCGImagePropertyExifLensModel: "CubeTestLensModel",
    kCGImagePropertyExifBodySerialNumber: "CUBESERIAL123", kCGImagePropertyExifCameraOwnerName: "CubeTestOwner",
    kCGImagePropertyExifUserComment: "CubeTestComment",
  ],
  kCGImagePropertyGPSDictionary: [
    kCGImagePropertyGPSLatitude: 48.8584, kCGImagePropertyGPSLatitudeRef: "N",
    kCGImagePropertyGPSLongitude: 2.2945, kCGImagePropertyGPSLongitudeRef: "E",
    kCGImagePropertyGPSAltitude: 35.0,
  ],
]

func write(_ img: CGImage, _ url: URL, _ type: UTType) {
  guard let dst = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { fail("no writer for \(type)") }
  var p = props
  if type != .png { p[kCGImageDestinationLossyCompressionQuality] = 0.9 }
  CGImageDestinationAddImage(dst, img, p as CFDictionary)
  if !CGImageDestinationFinalize(dst) { fail("could not write \(url.path)") }
}

func load(_ path: String) -> (props: [String: Any], pixels: [UInt8], w: Int, h: Int) {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
        let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any] else { fail("cannot decode \(path)") }
  let w = img.width, h = img.height
  var px = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  return (p, px, w, h)
}

let args = CommandLine.arguments
if args.count == 3 && args[1] == "make" {
  let dir = URL(fileURLWithPath: args[2]), img = gradient()
  write(img, dir.appendingPathComponent("photo.jpg"), .jpeg)
  write(img, dir.appendingPathComponent("photo.heic"), .heic)
  write(img, dir.appendingPathComponent("photo.png"), .png)
} else if args.count == 4 && args[1] == "check" {
  let a = load(args[2]), b = load(args[3])
  let name = (args[2] as NSString).lastPathComponent
  if a.w != b.w || a.h != b.h || a.pixels != b.pixels { fail("\(name): pixels changed") }
  if a.props[kCGImagePropertyGPSDictionary as String] == nil { fail("\(name): original has no GPS, bad fixture") }
  if let g = b.props[kCGImagePropertyGPSDictionary as String] { fail("\(name): GPS left: \(g)") }
  let text = "\(b.props)"
  for s in ["CubeTest", "CUBESERIAL"] where text.contains(s) { fail("\(name): \(s) left in \(text)") }
  if (b.props[kCGImagePropertyOrientation as String] as? Int) != 6 { fail("\(name): orientation lost") }
  let exif = b.props[kCGImagePropertyExifDictionary as String] as? [String: Any]
  if exif?[kCGImagePropertyExifDateTimeOriginal as String] == nil { fail("\(name): capture date lost") }
  print("\(name): ok (\(b.w)x\(b.h), pixels identical, orientation and date kept, no GPS or camera details)")
} else {
  fail("usage: images.swift make <dir> | check <original> <stripped>")
}
