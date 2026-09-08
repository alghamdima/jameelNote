import React from "react";
import Image from "next/image";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { VisuallyHidden } from "./ui/visually-hidden";
import { About } from "./About";
import { presentation } from "@/config/presentation";

interface LogoProps {
    isCollapsed: boolean;
}

const Logo = React.forwardRef<HTMLButtonElement, LogoProps>(({ isCollapsed }, ref) => {
  const logo = isCollapsed ? (
    <Image src="/logo-collapsed.png" alt="JameelNote" width={36} height={36} />
  ) : (
    <Image src="/logo.png" alt="JameelNote" width={180} height={63} priority />
  );

  if (!presentation.showAbout) {
    return <div className="flex items-center justify-center mb-2">{logo}</div>;
  }

  return (
    <Dialog aria-describedby={undefined}>
      <DialogTrigger asChild>
        <button ref={ref} className="flex items-center justify-center mb-2 cursor-pointer bg-transparent border-none p-0 hover:opacity-80 transition-opacity">
          {logo}
        </button>
      </DialogTrigger>
      <DialogContent>
        <VisuallyHidden>
          <DialogTitle>About JameelNote</DialogTitle>
        </VisuallyHidden>
        <About />
      </DialogContent>
    </Dialog>
  );
});

Logo.displayName = "Logo";

export default Logo;
