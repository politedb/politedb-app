import { SVGAttributes } from "preact";

export function ChatIcon(props: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M19 16H16.475C16.3259 16.0001 16.1788 16.0339 16.0446 16.0988C15.9104 16.1638 15.7926 16.2582 15.7 16.375L12.775 20.025C12.6813 20.1422 12.5625 20.2367 12.4273 20.3017C12.2921 20.3667 12.144 20.4005 11.994 20.4005C11.844 20.4005 11.6959 20.3667 11.5607 20.3017C11.4255 20.2367 11.3067 20.1422 11.213 20.025L8.288 16.375C8.19529 16.258 8.07733 16.1636 7.94295 16.0986C7.80857 16.0337 7.66125 16 7.512 16H5C3.338 16 2 14.662 2 13V6C2 4.338 3.338 3 5 3H19C20.663 3 22 4.338 22 6V13C22 14.662 20.663 16 19 16Z"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-miterlimit="10"
        stroke-linejoin="round"
      />
    </svg>
  );
}
