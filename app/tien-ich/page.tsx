import { Wrench } from "lucide-react";
import { ToolDirectory } from "./tool-directory";

export default function TienIchPage() {
  return (
    <div className="md:flex md:min-h-[400px] md:flex-col md:items-center md:justify-center md:text-center">
      <Wrench aria-hidden="true" className="hidden w-12 h-12 text-gray-400 mb-4 md:block" />
      <h1 className="mb-1 text-xl font-bold text-gray-800 md:mb-2">Tiện ích</h1>
      <p className="text-sm text-gray-600 md:max-w-xs">Chọn một tiện ích để bắt đầu.</p>
      <div className="mt-4 md:hidden">
        <ToolDirectory />
      </div>
    </div>
  );
}
